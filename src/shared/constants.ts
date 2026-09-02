/**
 * Shared constants for Local Agent.
 *
 * This module is consumed by every process, including the sandboxed renderer.
 * It must contain pure data only: no I/O, no Electron, no Node built-ins.
 */

// ---------------------------------------------------------------------------
// Product identity
// ---------------------------------------------------------------------------

/** Human-readable product name. */
export const APP_PRODUCT_NAME = 'Local Agent';

/**
 * Folder name used under the Windows per-user application-data directory.
 * Resolves to `%APPDATA%\Local-Agent\`.
 *
 * Runtime user data lives here and never inside the repository.
 */
export const APP_DATA_DIR_NAME = 'Local-Agent';

/** Default assistant name offered during first-run onboarding. */
export const DEFAULT_ASSISTANT_NAME = 'JARVIS';

// ---------------------------------------------------------------------------
// Schema versions
//
// Every persisted file carries its schema version so that a future migration
// never has to guess at the shape of an existing file.
// ---------------------------------------------------------------------------

export const SETTINGS_SCHEMA_VERSION = 1;
export const PERMISSION_POLICY_SCHEMA_VERSION = 1;
export const AUDIT_SCHEMA_VERSION = 1;
export const EMERGENCY_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// User-data layout (paths are relative to the application-data directory)
//
// Code, settings, secrets, permission policy, audit logs and memory are kept
// in separate locations so that no single file mixes concerns.
// ---------------------------------------------------------------------------

export const USER_DATA_PATHS = {
  settingsFile: 'settings.json',
  permissionPolicyFile: 'permissions/policy.json',
  secretsFile: 'secrets/secrets.enc',
  auditLogDir: 'logs/audit',
  emergencyStateFile: 'state/emergency.json',
  memoryDir: 'memory',
} as const;

/** Audit log file name pattern, one file per UTC day. */
export const AUDIT_LOG_FILE_PREFIX = 'audit-';
export const AUDIT_LOG_FILE_EXTENSION = '.jsonl';

// ---------------------------------------------------------------------------
// User interface languages
// ---------------------------------------------------------------------------

export const UI_LANGUAGES = ['en', 'fr', 'vi'] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];

export const DEFAULT_UI_LANGUAGE: UiLanguage = 'en';

// ---------------------------------------------------------------------------
// Model providers
//
// Phase 1 stores provider settings only. No model SDK is present, no network
// call is made, and no provider-specific behaviour exists anywhere in the
// codebase. Provider-specific behaviour arrives later, behind adapters.
// ---------------------------------------------------------------------------

export const MODEL_PROVIDERS = ['none', 'glm', 'openai-compatible', 'ollama'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export const DEFAULT_MODEL_PROVIDER: ModelProvider = 'none';

/** Providers that authenticate with an API key held in the secret store. */
export const PROVIDERS_REQUIRING_API_KEY: readonly ModelProvider[] = [
  'glm',
  'openai-compatible',
] as const;

// ---------------------------------------------------------------------------
// Field limits
// ---------------------------------------------------------------------------

export const ASSISTANT_NAME_MIN_LENGTH = 1;
export const ASSISTANT_NAME_MAX_LENGTH = 32;
export const USER_DISPLAY_NAME_MIN_LENGTH = 1;
export const USER_DISPLAY_NAME_MAX_LENGTH = 64;
export const MODEL_ID_MAX_LENGTH = 128;
export const BASE_URL_MAX_LENGTH = 2048;

/**
 * Rejects control characters, including newline, carriage return and NUL.
 *
 * User-supplied display strings end up in log lines and in the window title.
 * Excluding control characters removes log-injection and display-spoofing
 * tricks at the schema boundary rather than at each use site.
 */
// eslint-disable-next-line no-control-regex
export const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;

/**
 * Rejects Unicode bidirectional overrides and isolates.
 *
 * These characters reorder how text is *displayed* without changing what it
 * contains, which is the basis of the "Trojan Source" class of spoofing: a
 * name can be made to render as something other than what is stored and later
 * compared. Persisted display strings reach the window title, the interface
 * and audit output, so they are rejected at the schema boundary.
 *
 * Scope is deliberately narrow: the LRE/RLE/PDF/LRO/RLO block and the isolate
 * block. Ordinary French and Vietnamese text, including every accented and
 * combining character, is unaffected. No general-purpose script is blocked.
 */
export const BIDI_CONTROL_PATTERN = /[\u202A-\u202E\u2066-\u2069]/;

// ---------------------------------------------------------------------------
// Permission model
// ---------------------------------------------------------------------------

/**
 * Every privileged operation available in Phase 1.
 *
 * Phase 1 deliberately contains no filesystem tool, no shell execution and no
 * network action. The list stays this short until a later phase adds one, and
 * every addition needs a matching policy rule because unmatched actions are
 * denied.
 */
export const ACTION_TYPES = [
  'settings.read',
  'settings.write',
  'secrets.write',
  'secrets.clear',
  'secrets.status',
  'audit.read',
  'emergency.engage',
  'emergency.reset',
  'app.exit',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const PERMISSION_DECISIONS = ['allow', 'confirm', 'deny'] as const;
export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number];

/** An action with no matching policy rule is denied. */
export const DEFAULT_PERMISSION_DECISION: PermissionDecision = 'deny';

/**
 * Actions that always require explicit user confirmation.
 *
 * This is a hard floor enforced in code, not a policy default. Editing the
 * policy file cannot downgrade any of these to `allow`. It covers the
 * destructive, privacy-sensitive and security-sensitive operations of Phase 1.
 */
export const CONFIRMATION_REQUIRED_ACTION_TYPES: readonly ActionType[] = [
  'secrets.write',
  'secrets.clear',
  'emergency.reset',
  'app.exit',
] as const;

/**
 * Actions that remain available while the emergency stop is engaged.
 *
 * The user must always be able to inspect what happened and to release the
 * stop deliberately, otherwise an engaged stop would be an unrecoverable
 * state.
 */
export const EMERGENCY_STOP_EXEMPT_ACTION_TYPES: readonly ActionType[] = [
  'settings.read',
  'audit.read',
  'emergency.reset',
  'app.exit',
] as const;

/**
 * The emergency availability floor.
 *
 * The user must never lose the ability to stop the assistant, to recover from
 * having stopped it, or to find out what happened. A permission policy is a
 * user-editable file, so without a floor a policy could remove the user's own
 * emergency controls — either by denying them outright or, more quietly, by
 * simply omitting them and letting default-deny do the same thing.
 *
 * A valid policy must therefore declare a rule for **every** action listed
 * here, and **none** of those rules may be `deny`. Both halves are enforced by
 * `permissionPolicySchema`; omission is treated exactly as seriously as an
 * explicit denial.
 *
 * Note how this composes with {@link CONFIRMATION_REQUIRED_ACTION_TYPES}:
 * `emergency.reset` appears in both lists, so it cannot be `allow` and cannot
 * be `deny`. It is pinned to `confirm` — recovery stays possible, but only
 * through the deliberate confirmation flow.
 *
 * Schema validation is the first line of defence, not the only one. The
 * Milestone 5 permission engine must enforce this floor independently, at
 * decision time, so that a policy reaching the engine by some path that
 * bypassed validation still cannot suppress these actions. See
 * `docs/security-model.md`.
 */
export const EMERGENCY_AVAILABILITY_FLOOR_ACTION_TYPES: readonly ActionType[] = [
  'emergency.engage',
  'emergency.reset',
  'audit.read',
] as const;

/** Decision reason recorded when no policy rule matched an action. */
export const REASON_DEFAULT_DENY = 'default-deny';
/** Decision reason recorded when the emergency stop blocked an action. */
export const REASON_EMERGENCY_STOP = 'emergency-stop';
/** Decision reason recorded when the permission policy failed to load. */
export const REASON_POLICY_UNAVAILABLE = 'policy-unavailable';

// ---------------------------------------------------------------------------
// Audit model
// ---------------------------------------------------------------------------

export const AUDIT_ACTORS = ['user', 'system', 'model'] as const;
export type AuditActor = (typeof AUDIT_ACTORS)[number];

export const AUDIT_OUTCOMES = ['success', 'failure', 'denied', 'aborted'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export const CONFIRMATION_RESULTS = ['approved', 'rejected'] as const;
export type ConfirmationResult = (typeof CONFIRMATION_RESULTS)[number];

/** Replacement written in place of any value that may carry a secret. */
export const REDACTED_PLACEHOLDER = '[REDACTED]';

/**
 * Normalises a field name for secret-name comparison.
 *
 * Lowercases and strips every non-alphanumeric character, so that `apiKey`,
 * `api_key`, `API-KEY` and `api key` all reduce to the same token. Without
 * this, a denylist has to enumerate every spelling of every term and will
 * still miss one.
 */
export function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Canonical secret-bearing field-name roots, already normalised.
 *
 * Matching is by **substring of the normalised name**, so each entry is a
 * root rather than an exact name: `credential` also catches `credentials`,
 * `token` also catches `accessToken` and `refresh_token`, `secret` also
 * catches `clientSecret`. Entries are therefore intentionally minimal — no
 * entry is a substring of another, which is asserted by a unit test.
 *
 * This list is one source of truth, shared by:
 *
 *  - the audit parameter schema, which rejects a secret-named field unless
 *    its value is exactly {@link REDACTED_PLACEHOLDER};
 *  - the Milestone 4 audit writer, which performs the redaction;
 *  - the settings tests, which assert no secret-named field is declared.
 *
 * A name denylist is a necessary control but never a sufficient one: it
 * cannot see a credential hidden inside a *value*. Value-level controls are
 * separate — see the `baseUrl` userinfo rejection in the settings schema.
 */
export const SECRET_FIELD_NAMES: readonly string[] = [
  'apikey',
  'authorization',
  'bearer',
  'credential',
  'passphrase',
  'password',
  'privatekey',
  'secret',
  'token',
] as const;

/**
 * Whether a field name looks capable of carrying a credential.
 *
 * Used by the audit parameter schema and by tests. Case-, separator- and
 * spelling-insensitive; see {@link normalizeFieldName}.
 */
export function isSecretFieldName(name: string): boolean {
  const normalized = normalizeFieldName(name);
  return SECRET_FIELD_NAMES.some((root) => normalized.includes(root));
}

// ---------------------------------------------------------------------------
// Audit parameter limits
//
// Audit parameters come from action payloads, which originate outside the
// privileged process. `Record<string, unknown>` is far too permissive for a
// security log format, so the shape is bounded: JSON-safe values only, with
// caps on depth, breadth and size.
//
// The limits are chosen to be generous enough that real audit records stay
// useful, and tight enough that a hostile or runaway payload cannot produce an
// unbounded log line.
// ---------------------------------------------------------------------------

/** Maximum nesting depth. The parameter object itself is depth 1. */
export const AUDIT_PARAM_MAX_DEPTH = 8;
/** Maximum number of keys in any single object. */
export const AUDIT_PARAM_MAX_KEYS = 64;
/** Maximum number of elements in any single array. */
export const AUDIT_PARAM_MAX_ARRAY_LENGTH = 256;
/** Maximum length of any single string value. */
export const AUDIT_PARAM_MAX_STRING_LENGTH = 4096;
/** Maximum length of any single key. */
export const AUDIT_PARAM_MAX_KEY_LENGTH = 128;
/** Maximum total number of values across the whole parameter tree. */
export const AUDIT_PARAM_MAX_TOTAL_NODES = 1024;

/**
 * Object keys refused outright in audit parameters.
 *
 * These names have special meaning during object construction and are a
 * standard prototype-pollution vector. Note that this is a narrow check on the
 * audit format only; hardening the JSON *loaders* against the same trick
 * belongs to the Milestone 3 settings loader.
 */
export const FORBIDDEN_OBJECT_KEYS: readonly string[] = [
  '__proto__',
  'constructor',
  'prototype',
] as const;
