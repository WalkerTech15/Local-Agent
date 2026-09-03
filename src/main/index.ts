import { app, BrowserWindow, ipcMain, safeStorage, session } from 'electron';
import { join } from 'node:path';

import { showNativeConfirmation } from './confirm';
import { loadEmergencyState } from './emergency';
import { registerIpcHandlers } from './ipc';
import { resolveUserDataPaths } from './paths';
import { loadPermissionPolicy } from './policy';
import { loadSettings } from './settings';

/**
 * Strict Content-Security-Policy for every response in the default session.
 *
 * No remote source appears anywhere: the renderer loads only the packaged
 * `file://` bundle, so every directive that could admit a network origin is
 * either `'self'` or `'none'`. `script-src`/`style-src` carry no
 * `unsafe-inline` or `unsafe-eval` — nothing in the renderer needs either,
 * and allowing them would reopen exactly the injection class CSP exists to
 * close. `connect-src 'none'` additionally blocks `fetch`/`XHR`/`WebSocket`
 * outright, since Phase 1 makes no network call of any kind.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      webviewTag: false,
      preload: join(__dirname, '../preload/index.js'),
    },
  });

  void window.loadFile(join(__dirname, '../../dist/renderer/index.html'));
  return window;
}

/**
 * Denies every capability a compromised or malicious page could otherwise
 * reach through a `WebContents`, for the main window and for any other
 * `WebContents` Electron ever creates in this app.
 *
 * Registered on `app` rather than on the window instance so that it applies
 * to every `WebContents` unconditionally — the recommended pattern from
 * Electron's security checklist — rather than relying on each call site to
 * remember to attach it.
 */
function hardenWebContents(): void {
  app.on('web-contents-created', (_event, contents) => {
    // No navigation away from the packaged local bundle: not to a remote
    // origin, and not to another local file.
    contents.on('will-navigate', (navigationEvent) => {
      navigationEvent.preventDefault();
    });

    // No new window or tab of any kind, local or remote.
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));

    // Belt-and-suspenders alongside `webviewTag: false`: refuse to attach a
    // <webview> even if one somehow reached the DOM.
    contents.on('will-attach-webview', (attachEvent) => {
      attachEvent.preventDefault();
    });
  });
}

app
  .whenReady()
  .then(async () => {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [CONTENT_SECURITY_POLICY],
        },
      });
    });

    // Local Agent requests no OS permission in Phase 1 — no camera, no
    // microphone, no location, no notifications. Denying every request
    // outright means a future dependency or a compromised page cannot
    // silently prompt for one.
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false);
    });

    // Read-only at this point: proves the real application-data path
    // resolves and loads (or safely falls back) before the window opens,
    // failing fast rather than only on the first IPC call. Nothing is
    // written here — every one of Milestone 7's real IPC handlers
    // (`main/ipc.ts`) re-reads the policy and emergency state fresh on every
    // call instead of trusting this startup snapshot, so a hand-edited
    // policy file or a just-engaged emergency stop take effect on the very
    // next action without a restart.
    const userDataPaths = resolveUserDataPaths(app.getPath('appData'));
    const startupNow = new Date().toISOString();
    await loadSettings(userDataPaths.settingsFile, startupNow);
    await loadPermissionPolicy(userDataPaths.permissionPolicyFile);
    await loadEmergencyState(userDataPaths.emergencyStateFile, startupNow);

    const window = createWindow();

    registerIpcHandlers(ipcMain, {
      userDataPaths,
      safeStorage,
      requestConfirmation: (message) =>
        showNativeConfirmation(window.isDestroyed() ? null : window, message),
      nowFn: () => new Date().toISOString(),
    });
  })
  .catch((error: unknown) => {
    console.error('Failed to start Local Agent:', error);
    app.exit(1);
  });

hardenWebContents();

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
