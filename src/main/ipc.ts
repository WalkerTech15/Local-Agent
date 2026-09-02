/**
 * IPC handler registration for Local Agent.
 *
 * `main` is the only layer that registers `ipcMain` handlers; `preload` only
 * ever calls `ipcRenderer.invoke` against a channel named here. Every handler
 * validates its incoming arguments and its outgoing result against the
 * shared schema for that channel before either crosses the process boundary,
 * so a malformed call or a malformed result fails loudly instead of reaching
 * untrusted code.
 *
 * Milestone 2 registers exactly one channel. Later milestones add channels
 * here, each behind its own schema — never a generic pass-through.
 */

import type { IpcMain } from 'electron';

import {
  healthCheckRequestSchema,
  healthCheckResponseSchema,
  IPC_HEALTH_CHANNEL,
} from '../shared/schemas';

/**
 * `ipcMain` is passed in rather than imported here.
 *
 * Electron's ESM support for its built-in `electron` module fully resolves
 * `import ... from 'electron'` only in the process entry file; a value
 * import of it from a second statically-imported module resolves to the
 * unrelated `electron` npm package instead (its own path-to-binary helper,
 * not the runtime API) and fails at startup. `index.ts` is the only file
 * that imports the live `electron` module; everything else receives what it
 * needs as an argument. A type-only import is unaffected — it is erased
 * before anything runs — so `IpcMain` above is safe.
 */
export function registerIpcHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_HEALTH_CHANNEL, (_event, ...args: unknown[]) => {
    healthCheckRequestSchema.parse(args);
    return healthCheckResponseSchema.parse({ status: 'ok' });
  });
}
