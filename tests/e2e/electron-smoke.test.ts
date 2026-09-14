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
const EXPECTED_BRIDGE_KEYS = [
  'agent',
  'chat',
  'command',
  'git',
  'health',
  'memory',
  'secrets',
  'settings',
  'workspace',
] as const;
const EXPECTED_SETTINGS_KEYS = ['get', 'update'] as const;
const EXPECTED_SECRETS_KEYS = ['clear', 'status', 'write'] as const;
const EXPECTED_CHAT_KEYS = ['cancel', 'onChunk', 'send'] as const;
/**
 * The coding workspace (Phase 2, Milestones 5-6).
 *
 * `select` takes no argument at all, so the directory that becomes readable
 * is chosen by the user in a native dialog the main process owns. `propose`
 * is the only function that carries file content, and it writes nothing;
 * `apply` takes a change identifier and nothing else, so the bytes written
 * are necessarily the bytes that were diffed and shown. There is no
 * `create`, no `delete` and no `patch`.
 */
const EXPECTED_WORKSPACE_KEYS = [
  'apply',
  'changes',
  'file',
  'plan',
  'propose',
  'rollback',
  'search',
  'select',
  'status',
  'tree',
] as const;
/**
 * The command registry (Phase 2, Milestone 6). `run` takes a run id and an
 * identifier from a five-value enum — there is no function here through which
 * a command string, an argument, a shell or a working directory could be
 * supplied.
 */
const EXPECTED_COMMAND_KEYS = ['cancel', 'list', 'run'] as const;
/**
 * Git (Phase 2, Milestone 6). Two reads and one commit. There is no reset, no
 * checkout, no branch, no push and no remote — not disabled, absent.
 */
const EXPECTED_GIT_KEYS = ['checkpoint', 'diff', 'status'] as const;
/**
 * Agent profiles (Phase 2, Milestone 7). Six configuration functions, one
 * bounded run and one cancel. `run` takes a run id and an objective — there
 * is no function here through which a step, a tool, a path, a command or a
 * limit could be supplied, because what a run may do comes from the stored
 * profile the main process reads.
 */
const EXPECTED_AGENT_KEYS = [
  'cancel',
  'create',
  'list',
  'remove',
  'run',
  'select',
  'setEnabled',
  'update',
] as const;
/**
 * Local memory (Phase 2, Milestone 8). Three reads, four single-record
 * writes, and three bulk operations. Note what cannot be supplied through any
 * of them: a file path — `exportScope` and `importScope` take a scope, and
 * the file is chosen by the user in a native dialog the main process owns —
 * and a record's `source`, which the main process stamps. There is no
 * `capture`, no `learn` and no `observe`.
 */
const EXPECTED_MEMORY_KEYS = [
  'add',
  'clear',
  'exportScope',
  'importScope',
  'list',
  'remove',
  'retrieve',
  'search',
  'setPinned',
  'update',
] as const;

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
    await page.waitForURL('file://**/dist/renderer/index.html', {
      waitUntil: 'domcontentloaded',
    });
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

  it('exposes exactly one bridge object with exactly the narrow, named functions of Phase 2 Milestone 8', async () => {
    const bridgeShape = await page.evaluate(() => {
      const w = window as unknown as {
        localAgent?: {
          settings?: object;
          secrets?: object;
          chat?: object;
          workspace?: object;
          command?: object;
          git?: object;
          agent?: object;
          memory?: object;
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
        commandKeys: localAgent?.command ? Object.keys(localAgent.command).sort() : [],
        gitKeys: localAgent?.git ? Object.keys(localAgent.git).sort() : [],
        agentKeys: localAgent?.agent ? Object.keys(localAgent.agent).sort() : [],
        memoryKeys: localAgent?.memory ? Object.keys(localAgent.memory).sort() : [],
      };
    });
    expect(bridgeShape).toEqual({
      hasBridge: true,
      keys: [...EXPECTED_BRIDGE_KEYS],
      settingsKeys: [...EXPECTED_SETTINGS_KEYS],
      secretsKeys: [...EXPECTED_SECRETS_KEYS],
      chatKeys: [...EXPECTED_CHAT_KEYS],
      workspaceKeys: [...EXPECTED_WORKSPACE_KEYS],
      commandKeys: [...EXPECTED_COMMAND_KEYS],
      gitKeys: [...EXPECTED_GIT_KEYS],
      agentKeys: [...EXPECTED_AGENT_KEYS],
      memoryKeys: [...EXPECTED_MEMORY_KEYS],
    });
  });

  it('exposes no memory function that could name a file or record something automatically', async () => {
    // Two absences are the control here, so both are asserted against the
    // real built bridge rather than only against the source. Nothing in the
    // memory object can name a path — the export and import dialogs are owned
    // by the main process — and nothing can capture a memory from a
    // conversation, a file or a model reply.
    const present = await page.evaluate(() => {
      const w = window as unknown as { localAgent?: { memory?: Record<string, unknown> } };
      const memory = w.localAgent?.memory;
      if (memory === undefined) return ['(no memory object at all)'];
      const forbidden = [
        'capture',
        'learn',
        'observe',
        'infer',
        'remember',
        'readFile',
        'writeFile',
        'exportTo',
        'importFrom',
        'path',
        'file',
        'sync',
        'upload',
        'grant',
      ];
      return forbidden.filter((key) => key in memory);
    });
    expect(present).toEqual([]);
  });

  it('exposes no function that can create, delete or patch a file', async () => {
    // Milestone 6 can overwrite a file the user approved, after a native
    // confirmation. It still cannot bring one into existence or remove one,
    // and the absence is the control — so it is asserted against the real
    // built bridge rather than only against the source that produces it.
    const present = await page.evaluate(() => {
      const w = window as unknown as {
        localAgent?: { workspace?: Record<string, unknown> };
      };
      const workspace = w.localAgent?.workspace;
      if (workspace === undefined) return ['(no workspace object at all)'];
      const forbidden = [
        'write',
        'writeFile',
        'create',
        'createFile',
        'delete',
        'remove',
        'unlink',
        'rename',
        'move',
        'copy',
        'mkdir',
        'patch',
        'exec',
        'execute',
        'spawn',
        'shell',
        'commit',
      ];
      return forbidden.filter((key) => key in workspace);
    });
    expect(present).toEqual([]);
  });

  it('exposes every changing operation as a plain function carrying no extra surface', async () => {
    // `contextBridge` clones functions into the isolated world, so a
    // function's declared arity is *not* observable here — every bridge
    // function reports `length === 0` regardless of its signature. What can
    // be checked from the renderer is that each one is a plain function with
    // no own properties through which further capability could be reached.
    // That a change is applied by identifier, and that a request carrying a
    // path or content is rejected, is enforced by the request schemas in the
    // main process and asserted in `tests/unit/shared/coding.schema.test.ts`
    // and `tests/unit/main/ipc-coding.test.ts`.
    const report = await page.evaluate(() => {
      const w = window as unknown as {
        localAgent?: {
          workspace?: Record<string, unknown>;
          command?: Record<string, unknown>;
          git?: Record<string, unknown>;
        };
      };
      const targets: [string, unknown][] = [
        ['workspace.apply', w.localAgent?.workspace?.apply],
        ['workspace.rollback', w.localAgent?.workspace?.rollback],
        ['workspace.propose', w.localAgent?.workspace?.propose],
        ['command.run', w.localAgent?.command?.run],
        ['git.checkpoint', w.localAgent?.git?.checkpoint],
      ];
      // Only the intrinsic properties every function has. Anything beyond
      // these would be a further capability hanging off the bridge.
      const intrinsic = ['length', 'name', 'prototype'];
      return targets.map(([name, value]) => ({
        name,
        isFunction: typeof value === 'function',
        extraKeys:
          typeof value === 'function'
            ? Object.getOwnPropertyNames(value).filter((key) => !intrinsic.includes(key))
            : ['(not a function)'],
      }));
    });

    for (const entry of report) {
      expect(entry.isFunction, entry.name).toBe(true);
      expect(entry.extraKeys, entry.name).toEqual([]);
    }
  });

  it('exposes no generic command runner and no destructive Git operation', async () => {
    const present = await page.evaluate(() => {
      const w = window as unknown as {
        localAgent?: { command?: Record<string, unknown>; git?: Record<string, unknown> };
      };
      const command = w.localAgent?.command;
      const git = w.localAgent?.git;
      if (command === undefined || git === undefined) return ['(a required object is missing)'];

      const forbiddenCommands = ['exec', 'execute', 'spawn', 'shell', 'raw', 'eval', 'powershell'];
      const forbiddenGit = [
        'reset',
        'checkout',
        'switch',
        'restore',
        'clean',
        'branch',
        'push',
        'pull',
        'fetch',
        'remote',
        'rebase',
        'merge',
        'stash',
        'tag',
        'config',
        'commit',
      ];
      return [
        ...forbiddenCommands.filter((key) => key in command).map((key) => `command.${key}`),
        ...forbiddenGit.filter((key) => key in git).map((key) => `git.${key}`),
      ];
    });
    expect(present).toEqual([]);
  });

  it('exposes no agent function that could grant a permission or write anything', async () => {
    // Milestone 7's central claim, checked against the real built bridge: an
    // agent profile is configuration that narrows, and a run inspects, plans
    // and verifies. Nothing named like a grant or a write may appear.
    const present = await page.evaluate(() => {
      const w = window as unknown as { localAgent?: { agent?: Record<string, unknown> } };
      const agent = w.localAgent?.agent;
      if (agent === undefined) return ['(no agent object at all)'];

      const forbidden = [
        'grant',
        'allow',
        'permit',
        'authorize',
        'elevate',
        'write',
        'apply',
        'rollback',
        'checkpoint',
        'commit',
        'execute',
        'exec',
        'spawn',
        'invoke',
        'setPolicy',
        'setPermission',
        'addTool',
        'registerTool',
      ];
      return forbidden.filter((key) => key in agent);
    });

    expect(present).toEqual([]);
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
            agent?: Record<string, unknown>;
          })
        | undefined;
      const nested = [
        localAgent?.settings,
        localAgent?.secrets,
        localAgent?.chat,
        localAgent?.workspace,
        localAgent?.agent,
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
            agent?: Record<string, unknown>;
          })
        | undefined;
      const surfaces = [
        localAgent,
        localAgent?.settings,
        localAgent?.secrets,
        localAgent?.chat,
        localAgent?.workspace,
        localAgent?.agent,
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
