export const UPDATE_PROVIDERS: readonly string[];

export interface UpdateConfigResult {
  readonly requested: boolean;
  readonly ok: boolean;
  readonly problems: readonly string[];
}

export interface UpdateConfigDeps {
  readonly fileExists?: (path: string) => boolean;
  readonly evaluateSigningConfig?: (
    env: Readonly<Record<string, string | undefined>>,
    deps?: unknown,
  ) => { readonly requested: boolean; readonly ok: boolean; readonly problems: readonly string[] };
}

export function evaluateUpdateConfig(
  env: Readonly<Record<string, string | undefined>>,
  deps?: UpdateConfigDeps,
): UpdateConfigResult;
