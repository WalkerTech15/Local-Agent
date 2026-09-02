import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { resolveUserDataPaths } from '../../../src/main/paths';
import { APP_DATA_DIR_NAME, USER_DATA_PATHS } from '../../../src/shared/constants';

describe('resolveUserDataPaths', () => {
  it('anchors every path under <appDataDir>/Local-Agent', () => {
    const appDataDir = join('C:', 'fixtures', 'appdata');
    const paths = resolveUserDataPaths(appDataDir);

    const root = join(appDataDir, APP_DATA_DIR_NAME);
    expect(paths.userDataDir).toBe(root);
    expect(paths.settingsFile).toBe(join(root, USER_DATA_PATHS.settingsFile));
    expect(paths.permissionPolicyFile).toBe(join(root, USER_DATA_PATHS.permissionPolicyFile));
    expect(paths.secretsFile).toBe(join(root, USER_DATA_PATHS.secretsFile));
    expect(paths.auditLogDir).toBe(join(root, USER_DATA_PATHS.auditLogDir));
    expect(paths.emergencyStateFile).toBe(join(root, USER_DATA_PATHS.emergencyStateFile));
    expect(paths.memoryDir).toBe(join(root, USER_DATA_PATHS.memoryDir));
  });

  it('resolves under a different root when given a different application-data directory', () => {
    // Two distinct callers must never collide, and the function must not
    // memoise or otherwise depend on being called once.
    const first = resolveUserDataPaths(join('C:', 'Users', 'alex', 'AppData', 'Roaming'));
    const second = resolveUserDataPaths(join('C:', 'Users', 'morgan', 'AppData', 'Roaming'));

    expect(first.settingsFile).not.toBe(second.settingsFile);
    expect(first.settingsFile).toContain('alex');
    expect(second.settingsFile).toContain('morgan');
  });

  it('never hardcodes a username or a fixed drive/profile path', () => {
    // The only input is appDataDir; every segment after it comes from the
    // shared constants, not from the current machine.
    const paths = resolveUserDataPaths(join('Z:', 'anything', 'at', 'all'));
    expect(paths.userDataDir.startsWith(join('Z:', 'anything', 'at', 'all'))).toBe(true);
  });

  it('places settings.json directly under the resolved user-data directory', () => {
    const appDataDir = join('C:', 'fixtures', 'appdata');
    const paths = resolveUserDataPaths(appDataDir);
    expect(paths.settingsFile).toBe(join(paths.userDataDir, 'settings.json'));
  });
});
