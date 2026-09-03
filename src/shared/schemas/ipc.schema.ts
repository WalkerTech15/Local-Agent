/**
 * IPC channel contracts for Local Agent.
 *
 * Every channel the preload bridge is allowed to call is named here as an
 * explicit constant — never a string literal duplicated in `main` and
 * `preload` — and paired with a schema for its request and its response.
 * `main/ipc` validates both directions before a handler runs and before a
 * result crosses back into the renderer, so a malformed call or a
 * malformed result fails loudly instead of reaching untrusted code.
 *
 * Milestone 2 established exactly one channel: a liveness check with no
 * useful payload, to prove the request path end to end — preload → main →
 * validated response → renderer — before any privileged channel existed.
 * Milestone 7 adds the first privileged channels: non-secret settings
 * (read/update) and the encrypted secret store (status/write/clear). Every
 * one of them is routed through `main/action-pipeline.ts`'s
 * `handleActionProposal` — the same permission engine, confirmation floor,
 * emergency-stop gate and audit log every other action type uses — so none of
 * these schemas grant authority on their own; they only describe shape.
 *
 * Two properties hold for every channel below, by construction:
 *
 *  - **No plaintext secret ever appears in a request or response schema.**
 *    `secretsWriteRequestSchema` accepts a plaintext `apiKey` — the one
 *    necessary exception, since the renderer is the only place a user can
 *    type one — and every other schema here, including every response,
 *    carries only non-secret settings fields or the boolean-shaped
 *    {@link secretStatusResultSchema}. There is no schema anywhere in this
 *    file for reading a key back out.
 *  - **Every response carries `outcome`.** A privileged action can be denied
 *    by policy, blocked by the emergency stop, aborted by a rejected
 *    confirmation, or fail outright — the renderer must be able to tell those
 *    apart from a success rather than receiving a value only on the happy
 *    path and nothing otherwise.
 */

import { z } from 'zod';

import {
  API_KEY_MAX_LENGTH,
  API_KEY_MIN_LENGTH,
  AUDIT_OUTCOMES,
  CONTROL_CHARACTER_PATTERN,
} from '../constants';
import {
  assistantSettingsSchema,
  languageSettingsSchema,
  modelProviderInputSchema,
  settingsSchema,
  userSettingsSchema,
} from './settings.schema';

/** The only IPC channel Milestone 2 registers. */
export const IPC_HEALTH_CHANNEL = 'app:health';

/**
 * The health check takes no arguments. Validating this explicitly, rather
 * than assuming an empty call, means an unexpected extra argument — from a
 * future bug or a tampered call — is rejected instead of silently ignored.
 */
export const healthCheckRequestSchema = z.tuple([]);

export const healthCheckResponseSchema = z.strictObject({
  status: z.literal('ok'),
});

export type HealthCheckResponse = z.infer<typeof healthCheckResponseSchema>;

// ---------------------------------------------------------------------------
// Settings: settings.read / settings.write
// ---------------------------------------------------------------------------

export const IPC_SETTINGS_GET_CHANNEL = 'settings:get';
export const IPC_SETTINGS_UPDATE_CHANNEL = 'settings:update';

export const settingsGetRequestSchema = z.tuple([]);

/**
 * What a caller may set through `settings:update`. Deliberately narrower than
 * {@link settingsSchema}: no `schemaVersion` (fixed), no `updatedAt` (the main
 * process supplies the clock), no `telemetry` (hard-pinned in Phase 1), and no
 * `hasApiKey` (server-computed — see {@link modelProviderInputSchema}). A
 * request carrying any of those extra fields is rejected outright by
 * `strictObject`, not silently stripped.
 */
export const settingsUpdateRequestSchema = z.tuple([
  z.strictObject({
    onboardingCompleted: z.boolean(),
    assistant: assistantSettingsSchema,
    user: userSettingsSchema,
    language: languageSettingsSchema,
    modelProvider: modelProviderInputSchema,
  }),
]);

export type SettingsUpdateInput = z.infer<typeof settingsUpdateRequestSchema>[0];

/**
 * Shared response shape for both settings channels: the outcome of the
 * underlying `settings.read` / `settings.write` action, the resulting
 * (already `hasApiKey`-reconciled) settings on success, and a stable error
 * code — never a raw error message — on failure. `settings` and `errorCode`
 * are mutually exclusive in practice but both declared optional rather than
 * a discriminated union, matching `ActionResult`'s own shape.
 */
export const settingsActionResponseSchema = z.strictObject({
  outcome: z.enum(AUDIT_OUTCOMES),
  settings: settingsSchema.optional(),
  errorCode: z.string().max(64).optional(),
});

export const settingsGetResponseSchema = settingsActionResponseSchema;
export const settingsUpdateResponseSchema = settingsActionResponseSchema;

export type SettingsActionResponse = z.infer<typeof settingsActionResponseSchema>;

// ---------------------------------------------------------------------------
// Secrets: secrets.status / secrets.write / secrets.clear
//
// No channel here can return a plaintext key. `secretStatusResultSchema` is
// the only secret-adjacent value ever sent to the renderer: whether a key is
// present, never what it is. There is deliberately no "get key" channel.
// ---------------------------------------------------------------------------

export const IPC_SECRETS_STATUS_CHANNEL = 'secrets:status';
export const IPC_SECRETS_WRITE_CHANNEL = 'secrets:write';
export const IPC_SECRETS_CLEAR_CHANNEL = 'secrets:clear';

export const secretsStatusRequestSchema = z.tuple([]);
export const secretsClearRequestSchema = z.tuple([]);

/**
 * The plaintext key never leaves this one request schema. Bounded, and never
 * trimmed — see {@link API_KEY_MAX_LENGTH}'s doc comment for why mutating a
 * credential the user typed would be unsafe. Control characters are rejected:
 * a real bearer token or API key is never legitimately multi-line.
 */
export const secretsWriteRequestSchema = z.tuple([
  z.strictObject({
    apiKey: z
      .string()
      .min(API_KEY_MIN_LENGTH)
      .max(API_KEY_MAX_LENGTH)
      .refine((value) => !CONTROL_CHARACTER_PATTERN.test(value), {
        message: 'must not contain control characters',
      }),
  }),
]);

export const secretStatusResultSchema = z.strictObject({
  present: z.boolean(),
});

export type SecretStatusResult = z.infer<typeof secretStatusResultSchema>;

/** Shared response shape for all three secret channels. */
export const secretsActionResponseSchema = z.strictObject({
  outcome: z.enum(AUDIT_OUTCOMES),
  status: secretStatusResultSchema.optional(),
  errorCode: z.string().max(64).optional(),
});

export const secretsStatusResponseSchema = secretsActionResponseSchema;
export const secretsWriteResponseSchema = secretsActionResponseSchema;
export const secretsClearResponseSchema = secretsActionResponseSchema;

export type SecretsActionResponse = z.infer<typeof secretsActionResponseSchema>;
