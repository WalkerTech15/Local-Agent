export interface ReleaseMetadataResult {
  readonly releaseRequested: boolean;
  readonly ok: boolean;
  readonly problems: readonly string[];
}

export function evaluateReleaseMetadata(
  pkg: { readonly version?: unknown; readonly author?: unknown },
  env: Readonly<Record<string, string | undefined>>,
): ReleaseMetadataResult;
