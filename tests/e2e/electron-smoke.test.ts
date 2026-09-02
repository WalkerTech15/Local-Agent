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

  it('exposes exactly one bridge object with exactly one narrow, named function', async () => {
    const bridgeShape = await page.evaluate(() => {
      const w = window as unknown as { localAgent?: Record<string, unknown> };
      return {
        hasBridge: typeof w.localAgent === 'object',
        keys: w.localAgent ? Object.keys(w.localAgent).sort() : [],
      };
    });
    expect(bridgeShape).toEqual({ hasBridge: true, keys: ['health'] });
  });

  it('has no generic invoke-any-channel function anywhere on window', async () => {
    const hasGenericInvoke = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const candidates = ['electron', 'ipc', 'invoke'];
      const localAgent = w.localAgent as Record<string, unknown> | undefined;
      return (
        candidates.some((key) => key in w) || (localAgent !== undefined && 'invoke' in localAgent)
      );
    });
    expect(hasGenericInvoke).toBe(false);
  });

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
