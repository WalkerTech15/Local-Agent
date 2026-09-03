/**
 * Settings orchestration for Local Agent: read, onboarding/provider write,
 * and `hasApiKey` reconciliation against the encrypted secret store.
 *
 * `main/settings.ts` and `main/secrets.ts` each stay a narrow I/O boundary
 * for exactly one file, unaware of each other. This module is the one place
 * that combines them, so that a `hasApiKey` value the renderer receives is
 * never the raw, possibly-stale field `loadSettings` read off disk, but
 * always freshly reconciled against `main/secrets.ts`'s own presence check —
 * the secret store, never `settings.json`, is authoritative.
 */

import { hasStoredSecret } from './secrets';
import { loadSettings, writeSettings } from './settings';
import type { UserDataPaths } from './paths';
import { PROVIDERS_REQUIRING_API_KEY } from '../shared/constants';
import type { ModelProvider } from '../shared/constants';
import type {
  AssistantSettings,
  LanguageSettings,
  Settings,
  UserSettings,
} from '../shared/schemas';

/**
 * The correct `hasApiKey` value for `provider`, given what is actually in the
 * secret store.
 *
 * Two providers can never report a key present, regardless of what the
 * secret store holds: `'none'` (there is no provider to authenticate to) and
 * any provider outside {@link PROVIDERS_REQUIRING_API_KEY} such as `'ollama'`
 * (a local, unauthenticated endpoint in Phase 1 — nothing here ever validates
 * or calls it, but there is no reason to report a key as present for a
 * provider that has no use for one). This is a stricter *service-level*
 * policy layered on top of `settingsSchema`'s own floor (which only forbids
 * `hasApiKey: true` for `'none'`) — it never weakens that floor, only
 * narrows what this module chooses to compute.
 */
async function computeHasApiKey(provider: ModelProvider, secretsFile: string): Promise<boolean> {
  if (!PROVIDERS_REQUIRING_API_KEY.includes(provider)) {
    return false;
  }
  return hasStoredSecret(secretsFile);
}

/**
 * Reconciles `settings.modelProvider.hasApiKey` against the secret store,
 * persisting the correction if the on-disk value disagrees.
 *
 * Persisting here — rather than only returning a corrected in-memory copy —
 * means `settings.json` stays truthful even if nothing else ever reads it
 * again: a later raw read (a future migration, a support script) sees the
 * corrected value too, not just this process's callers.
 */
async function reconcileHasApiKey(paths: UserDataPaths, settings: Settings): Promise<Settings> {
  const actual = await computeHasApiKey(settings.modelProvider.provider, paths.secretsFile);
  if (actual === settings.modelProvider.hasApiKey) {
    return settings;
  }

  const reconciled: Settings = {
    ...settings,
    modelProvider: { ...settings.modelProvider, hasApiKey: actual },
  };
  await writeSettings(paths.settingsFile, reconciled);
  return reconciled;
}

/**
 * Loads settings and returns them with `hasApiKey` guaranteed to match the
 * secret store. The `perform` callback behind `settings.read`.
 */
export async function readReconciledSettings(paths: UserDataPaths, now: string): Promise<Settings> {
  const settings = await loadSettings(paths.settingsFile, now);
  return reconcileHasApiKey(paths, settings);
}

/** Fields a `settings.write` proposal may carry — never `hasApiKey`. */
export interface SettingsWriteInput {
  readonly onboardingCompleted: boolean;
  readonly assistant: AssistantSettings;
  readonly user: UserSettings;
  readonly language: LanguageSettings;
  readonly modelProvider: {
    readonly provider: ModelProvider;
    readonly model: string;
    readonly baseUrl: string;
  };
}

/**
 * Applies `input` on top of the current settings and persists the result.
 * The `perform` callback behind `settings.write`, used by both onboarding and
 * any later provider-settings change — there is only one write path.
 *
 * `hasApiKey` is never taken from `input`: it is recomputed here from the
 * secret store, for whichever provider `input` selects, exactly as
 * {@link readReconciledSettings} does for a plain read. `schemaVersion` and
 * `telemetry` are carried forward from the current document rather than
 * accepted as input, since neither is user-configurable in Phase 1.
 *
 * `writeSettings` re-validates the full document against `settingsSchema`
 * before persisting, which is what actually enforces "onboarding cannot
 * complete without a non-empty display name" and "`baseUrl` is required for
 * `openai-compatible`" — this function adds no validation of its own beyond
 * assembling the candidate document; a caller whose input fails either rule
 * receives the thrown `ZodError`, and nothing is written.
 */
export async function writeOnboardingSettings(
  paths: UserDataPaths,
  now: string,
  input: SettingsWriteInput,
): Promise<Settings> {
  const current = await loadSettings(paths.settingsFile, now);
  const hasApiKey = await computeHasApiKey(input.modelProvider.provider, paths.secretsFile);

  const next: Settings = {
    schemaVersion: current.schemaVersion,
    onboardingCompleted: input.onboardingCompleted,
    assistant: input.assistant,
    user: input.user,
    language: input.language,
    modelProvider: { ...input.modelProvider, hasApiKey },
    telemetry: current.telemetry,
    updatedAt: now,
  };

  await writeSettings(paths.settingsFile, next);
  return next;
}

/**
 * Re-reads settings and marks `hasApiKey` correct after a secret-store
 * mutation (`secrets.write` / `secrets.clear`) has already succeeded. The
 * caller is responsible for only calling this once the store operation
 * itself is confirmed successful — see `main/ipc.ts`'s secret handlers,
 * which perform the store write first and this second, so a failed store
 * operation never reaches here and `hasApiKey` is never set ahead of the
 * store it describes.
 */
export async function refreshHasApiKeyAfterSecretChange(
  paths: UserDataPaths,
  now: string,
): Promise<Settings> {
  const settings = await loadSettings(paths.settingsFile, now);
  return reconcileHasApiKey(paths, settings);
}
