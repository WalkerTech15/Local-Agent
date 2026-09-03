/// <reference lib="dom" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { join } from 'node:path';

/**
 * End-to-end smoke test for the Milestone 2 hardened Electron shell.
 *
 * Drives the real, built application — `npm run test:e2e` runs `npm run
 * build` first — and asserts the security properties by their observable
 * effect, not by re-reading the source that produces them: no public
 * Electron API returns an already-created window's effective
 * `sandbox`/`contextIsolation`/`nodeIntegration`/`webSecurity` flags, so
 * this suite checks what a compromised renderer could and could not do
 * instead.
 *
 * The sandboxed environment this may run in sets `ELECTRON_RUN_AS_NODE=1`,
 * which makes the `electron` binary behave as a plain Node runtime instead
 * of bootstrapping the app — every Electron API on `require('electron')`
 * comes back `undefined` and the window never opens. That variable is
 * stripped from the launched process's environment below so the test
 * exercises the real thing.
 */

const REPO_ROOT = process.cwd();

/** The bridge contract this suite is verifying, not importing it from the implementation. */
interface ExposedLocalAgentBridge {
  health: () => Promise<{ status: string }>;
}

/**
 * The complete, narrow bridge surface as of Milestone 7. Asserted by exact
 * key list rather than "at least these" so that a future channel added
 * without updating this test fails loudly here — the same reason the
 * Milestone 2 version of this test asserted `['health']` exactly. `settings`
 * and `secrets` were added in Milestone 7 for onboarding, provider settings,
 * and the encrypted secret store; both stay two narrow, explicitly named
 * sub-objects, never a generic invoke surface.
 */
const EXPECTED_BRIDGE_KEYS = ['health', 'secrets', 'settings'] as const;
const EXPECTED_SETTINGS_KEYS = ['get', 'update'] as const;
const EXPECTED_SECRETS_KEYS = ['clear', 'status', 'write'] as const;

function launchEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

describe('Electron desktop shell — security and health-check smoke test', () => {
  let app: ElectronApplication;
  let page: Page;

  beforeAll(async () => {
    app = await electron.launch({
      args: [join(REPO_ROOT, 'out', 'main', 'index.js')],
      cwd: REPO_ROOT,
      env: launchEnv(),
    });
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
  });

  afterAll(async () => {
    await app.close();
  });

  it('starts the main process and opens exactly one window', () => {
    expect(app.windows()).toHaveLength(1);
  });

  it('loads only the local packaged bundle, never a remote URL', () => {
    const url = page.url();
    expect(url.startsWith('file://')).toBe(true);
    expect(url).toContain('dist/renderer/index.html');
  });

  it('creates the window with the required minimum size from main/index.ts', async () => {
    const minimumSize = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('no window');
      return window.getMinimumSize();
    });
    expect(minimumSize).toEqual([720, 520]);
  });

  it('has no Node integration in the renderer: require, process and module are absent', async () => {
    const nodeGlobals = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return {
        require: typeof w.require,
        process: typeof w.process,
        module: typeof w.module,
        exports: typeof w.exports,
        __dirname: typeof w.__dirname,
      };
    });
    expect(nodeGlobals).toEqual({
      require: 'undefined',
      process: 'undefined',
      module: 'undefined',
      exports: 'undefined',
      __dirname: 'undefined',
    });
  });

  it('never exposes the raw ipcRenderer object to the renderer', async () => {
    const hasIpcRenderer = await page.evaluate(() => 'ipcRenderer' in window);
    expect(hasIpcRenderer).toBe(false);
  });

  it('exposes exactly one bridge object with exactly the narrow, named functions of Milestone 7', async () => {
    const bridgeShape = await page.evaluate(() => {
      const w = window as unknown as {
        localAgent?: { settings?: object; secrets?: object } & Record<string, unknown>;
      };
      const localAgent = w.localAgent;
      return {
        hasBridge: typeof localAgent === 'object',
        keys: localAgent ? Object.keys(localAgent).sort() : [],
        settingsKeys: localAgent?.settings ? Object.keys(localAgent.settings).sort() : [],
        secretsKeys: localAgent?.secrets ? Object.keys(localAgent.secrets).sort() : [],
      };
    });
    expect(bridgeShape).toEqual({
      hasBridge: true,
      keys: [...EXPECTED_BRIDGE_KEYS],
      settingsKeys: [...EXPECTED_SETTINGS_KEYS],
      secretsKeys: [...EXPECTED_SECRETS_KEYS],
    });
  });

  it('has no generic invoke-any-channel function anywhere on window, including its sub-objects', async () => {
    const hasGenericInvoke = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const candidates = ['electron', 'ipc', 'invoke'];
      const localAgent = w.localAgent as
        | (Record<string, unknown> & {
            settings?: Record<string, unknown>;
            secrets?: Record<string, unknown>;
          })
        | undefined;
      const nested = [localAgent?.settings, localAgent?.secrets].filter(
        (value): value is Record<string, unknown> => value !== undefined,
      );
      return (
        candidates.some((key) => key in w) ||
        (localAgent !== undefined && 'invoke' in localAgent) ||
        nested.some((value) => 'invoke' in value)
      );
    });
    expect(hasGenericInvoke).toBe(false);
  });

  // Deliberately no test here calls `settings.*` or `secrets.*` against the
  // real running app: unlike `health`, both have real side effects (an audit
  // write, a settings read/write) against the *real* `%APPDATA%\Local-Agent\`
  // — this suite never overrides that path, so exercising them belongs to
  // `tests/unit/main/ipc.test.ts`, which does so against a temporary
  // directory. This suite only inspects the bridge's static shape.

  it('answers the named, schema-validated health-check channel', async () => {
    const result = await page.evaluate(async () => {
      const w = window as unknown as { localAgent: ExposedLocalAgentBridge };
      return w.localAgent.health();
    });
    expect(result).toEqual({ status: 'ok' });
  });

  it('blocks renderer-initiated navigation to a remote origin', async () => {
    const urlBefore = page.url();
    await page.evaluate(() => {
      window.location.href = 'https://example.com/';
    });
    // will-navigate is synchronous prevention; give a macrotask for a
    // (would-be) navigation to have started before asserting it did not.
    await page.waitForTimeout(250);
    expect(page.url()).toBe(urlBefore);
  });

  it('blocks window.open to a remote origin: no second window is created', async () => {
    const opened = await page.evaluate(() => {
      const result = window.open('https://example.com/', '_blank');
      return result !== null;
    });
    expect(opened).toBe(false);
    expect(app.windows()).toHaveLength(1);
  });

  it('enforces the CSP: a network request from the renderer is blocked', async () => {
    const outcome = await page.evaluate(async () => {
      try {
        await fetch('https://example.com/');
        return 'allowed';
      } catch {
        return 'blocked';
      }
    });
    expect(outcome).toBe('blocked');
  });
});
