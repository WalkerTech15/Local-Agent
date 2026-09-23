export interface SigningConfigResult {
  readonly requested: boolean;
  readonly ok: boolean;
  readonly problems: readonly string[];
}

export interface SigningConfigDeps {
  readonly fileExists?: (path: string) => boolean;
}

export function evaluateSigningConfig(
  env: Readonly<Record<string, string | undefined>>,
  deps?: SigningConfigDeps,
): SigningConfigResult;
