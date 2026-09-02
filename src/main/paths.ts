/**
 * User-data path resolution for Local Agent.
 *
 * Single source of truth for every absolute path the application reads or
 * writes under the per-user application-data directory. Milestone 3 uses
 * only `settingsFile`; the rest are resolved now, from the same constants
 * Milestone 1 already declared (`USER_DATA_PATHS`), so Milestones 4-7 reuse
 * this module rather than re-deriving paths independently.
 *
 * Pure: no Electron import, no filesystem access, no clock. `appDataDir` is
 * the platform's per-user application-data root — in production,
 * `app.getPath('appData')`, resolved by the caller in `src/main/index.ts` —
 * never a path supplied by the renderer or by any untrusted input. Taking it
 * as a parameter rather than calling `app.getPath` here keeps this module
 * testable with a temporary directory and nothing else.
 */

import { join } from 'node:path';

import { APP_DATA_DIR_NAME, USER_DATA_PATHS } from '../shared/constants';

export interface UserDataPaths {
  /** `<appDataDir>/Local-Agent`. Created on first write; never assumed to exist. */
  readonly userDataDir: string;
  readonly settingsFile: string;
  readonly permissionPolicyFile: string;
  readonly secretsFile: string;
  readonly auditLogDir: string;
  readonly emergencyStateFile: string;
  readonly memoryDir: string;
}

/**
 * Resolves every user-data path from the application-data root.
 *
 * Never hardcodes a username or a developer's machine-specific path:
 * `appDataDir` is the only input, and every other segment comes from
 * `APP_DATA_DIR_NAME` / `USER_DATA_PATHS`, both already reviewed constants.
 */
export function resolveUserDataPaths(appDataDir: string): UserDataPaths {
  const userDataDir = join(appDataDir, APP_DATA_DIR_NAME);
  return {
    userDataDir,
    settingsFile: join(userDataDir, USER_DATA_PATHS.settingsFile),
    permissionPolicyFile: join(userDataDir, USER_DATA_PATHS.permissionPolicyFile),
    secretsFile: join(userDataDir, USER_DATA_PATHS.secretsFile),
    auditLogDir: join(userDataDir, USER_DATA_PATHS.auditLogDir),
    emergencyStateFile: join(userDataDir, USER_DATA_PATHS.emergencyStateFile),
    memoryDir: join(userDataDir, USER_DATA_PATHS.memoryDir),
  };
}
