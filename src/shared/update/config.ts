/**
 * Resolves whether auto-update is enabled, from configuration alone
 * (Phase 3, Milestone 4).
 *
 * Mirrors `scripts/check-signing-config.mjs`'s shape deliberately: a pure
 * function over an environment map, returning what is missing rather than
 * throwing, so the same logic can gate a build-time check and a runtime
 * decision with one reviewed implementation. Unlike that script, this one is
 * pure enough to live in `src/shared` — it never reads `process.env`
 * itself, and `isPackaged` is a parameter, never `electron`'s own
 * `app.isPackaged`.
 *
 * Every one of the four checks below defaults **closed**: any missing,
 * malformed, or merely-absent piece of configuration means `enabled: false`.
 * There is no partial-enable state.
 *
 * Pure: no I/O, no Node built-in, no Electron.
 */

export const UPDATE_PROVIDERS = ['github', 'generic'] as const;
export type UpdateProvider = (typeof UPDATE_PROVIDERS)[number];

export interface UpdateConfig {
  readonly enabled: boolean;
  readonly provider: UpdateProvider | null;
  readonly feedUrl: string | null;
  /** Every reason updates are not enabled. Empty when `enabled` is `true`. */
  readonly reasons: readonly string[];
}

export interface ResolveUpdateConfigContext {
  /**
   * Whether this is a packaged, installed build (Electron's own
   * `app.isPackaged`, read by the caller — never imported here). A
   * development run is never eligible for updates, regardless of any
   * environment variable: there is nothing to atomically replace.
   */
  readonly isPackaged: boolean;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export function resolveUpdateConfig(
  env: Readonly<Record<string, string | undefined>>,
  context: ResolveUpdateConfigContext,
): UpdateConfig {
  const reasons: string[] = [];

  const optedIn = env.LOCAL_AGENT_ENABLE_UPDATES === '1';
  if (!optedIn) {
    reasons.push('LOCAL_AGENT_ENABLE_UPDATES is not set to "1"');
  }

  if (!context.isPackaged) {
    reasons.push('this is not a packaged, installed build');
  }

  const feedUrl = (env.LOCAL_AGENT_UPDATE_FEED_URL ?? '').trim();
  const feedUrlValid = feedUrl !== '' && isHttpsUrl(feedUrl);
  if (feedUrl === '') {
    reasons.push('LOCAL_AGENT_UPDATE_FEED_URL is not set');
  } else if (!feedUrlValid) {
    reasons.push('LOCAL_AGENT_UPDATE_FEED_URL is not a valid https:// URL');
  }

  const providerValue = (env.LOCAL_AGENT_UPDATE_PROVIDER ?? '').trim();
  const provider = (UPDATE_PROVIDERS as readonly string[]).includes(providerValue)
    ? (providerValue as UpdateProvider)
    : null;
  if (provider === null) {
    reasons.push(`LOCAL_AGENT_UPDATE_PROVIDER must be one of: ${UPDATE_PROVIDERS.join(', ')}`);
  }

  const enabled = optedIn && context.isPackaged && feedUrlValid && provider !== null;

  return {
    enabled,
    provider: enabled ? provider : null,
    feedUrl: enabled ? feedUrl : null,
    reasons,
  };
}
