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
 * The complete, narrow bridge surface as of Phase 2, Milestone 3. Asserted
 * by exact key list rather than "at least these" so that a future channel
 * added without updating this test fails loudly here — the same reason the
 * Milestone 2 version of this test asserted `['health']` exactly. `settings`
 * and `secrets` were added in Milestone 7 for onboarding, provider settings,
 * and the encrypted secret store; `chat` was added in Phase 2 Milestone 3
 * for the one network-capable action in this codebase, and gained
 * `onChunk` — a subscription to one fixed, one-way streaming-preview
 * channel — in Milestone 4. Every one stays a narrow, explicitly named
 * sub-object, never a generic invoke or listen surface.
 */
const EXPECTED_BRIDGE_KEYS = ['chat', 'health', 'secrets', 'settings', 'workspace'] as const;
const EXPECTED_SETTINGS_KEYS = ['get', 'update'] as const;
const EXPECTED_SECRETS_KEYS = ['clear', 'status', 'write'] as const;
const EXPECTED_CHAT_KEYS = ['cancel', 'onChunk', 'send'] as const;
/**
 * The read-only coding workspace (Phase 2, Milestone 5). Every one of these
 * reads; there is deliberately no `write`, `create`, `delete` or `apply` — a
 * renderer cannot request a modification because no function here expresses
 * one. `select` additionally takes no argument at all, so the directory that
 * becomes readable is chosen by the user in a native dialog the main process
 * owns.
 */
const EXPECTED_WORKSPACE_KEYS = ['file', 'plan', 'search', 'select', 'status', 'tree'] as const;

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

  it('exposes exactly one bridge object with exactly the narrow, named functions of Phase 2 Milestone 5', async () => {
    const bridgeShape = await page.evaluate(() => {
      const w = window as unknown as {
        localAgent?: {
          settings?: object;
          secrets?: object;
          chat?: object;
          workspace?: object;
        } & Record<string, unknown>;
      };
      const localAgent = w.localAgent;
      return {
        hasBridge: typeof localAgent === 'object',
        keys: localAgent ? Object.keys(localAgent).sort() : [],
        settingsKeys: localAgent?.settings ? Object.keys(localAgent.settings).sort() : [],
        secretsKeys: localAgent?.secrets ? Object.keys(localAgent.secrets).sort() : [],
        chatKeys: localAgent?.chat ? Object.keys(localAgent.chat).sort() : [],
        workspaceKeys: localAgent?.workspace ? Object.keys(localAgent.workspace).sort() : [],
      };
    });
    expect(bridgeShape).toEqual({
      hasBridge: true,
      keys: [...EXPECTED_BRIDGE_KEYS],
      settingsKeys: [...EXPECTED_SETTINGS_KEYS],
      secretsKeys: [...EXPECTED_SECRETS_KEYS],
      chatKeys: [...EXPECTED_CHAT_KEYS],
      workspaceKeys: [...EXPECTED_WORKSPACE_KEYS],
    });
  });

  it('exposes no workspace function capable of modifying anything', async () => {
    // The absence is the control, so it is asserted against the real built
    // bridge rather than only against the source that produces it.
    const hasMutator = await page.evaluate(() => {
      const w = window as unknown as {
        localAgent?: { workspace?: Record<string, unknown> };
      };
      const workspace = w.localAgent?.workspace;
      if (workspace === undefined) return true;
      const mutators = [
        'write',
        'writeFile',
        'create',
        'createFile',
        'delete',
        'remove',
        'rename',
        'move',
        'apply',
        'applyPlan',
        'patch',
        'exec',
        'execute',
        'run',
        'commit',
      ];
      return mutators.some((key) => key in workspace);
    });
    expect(hasMutator).toBe(false);
  });

  it('has no generic invoke-any-channel function anywhere on window, including its sub-objects', async () => {
    const hasGenericInvoke = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const candidates = ['electron', 'ipc', 'invoke'];
      const localAgent = w.localAgent as
        | (Record<string, unknown> & {
            settings?: Record<string, unknown>;
            secrets?: Record<string, unknown>;
            chat?: Record<string, unknown>;
            workspace?: Record<string, unknown>;
          })
        | undefined;
      const nested = [
        localAgent?.settings,
        localAgent?.secrets,
        localAgent?.chat,
        localAgent?.workspace,
      ].filter((value): value is Record<string, unknown> => value !== undefined);
      return (
        candidates.some((key) => key in w) ||
        (localAgent !== undefined && 'invoke' in localAgent) ||
        nested.some((value) => 'invoke' in value)
      );
    });
    expect(hasGenericInvoke).toBe(false);
  });

  it('has no generic listen-to-any-channel function either, despite exposing one event subscription', async () => {
    // `chat.onChunk` subscribes to one fixed channel chosen in the preload,
    // not to a caller-supplied one. Nothing named like a generic emitter API
    // may appear anywhere on the bridge.
    const hasGenericListener = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const generic = ['on', 'once', 'addListener', 'removeListener', 'off', 'emit'];
      const localAgent = w.localAgent as
        | (Record<string, unknown> & {
            settings?: Record<string, unknown>;
            secrets?: Record<string, unknown>;
            chat?: Record<string, unknown>;
            workspace?: Record<string, unknown>;
          })
        | undefined;
      const surfaces = [
        localAgent,
        localAgent?.settings,
        localAgent?.secrets,
        localAgent?.chat,
        localAgent?.workspace,
      ];
      return surfaces.some(
        (surface) => surface !== undefined && generic.some((key) => key in surface),
      );
    });
    expect(hasGenericListener).toBe(false);
  });

  // Deliberately no test here calls `settings.*`, `secrets.*`, or `chat.*`
  // against the real running app: unlike `health`, all three have real side
  // effects (an audit write, a settings read/write, and — for `chat.send` —
  // an actual network request to whatever provider is configured) against
  // the *real* `%APPDATA%\Local-Agent\` — this suite never overrides that
  // path and must never make a real network call in a test, so exercising
  // them belongs to `tests/unit/main/ipc.test.ts`, which does so against a
  // temporary directory and a mocked `fetch`. This suite only inspects the
  // bridge's static shape.

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
