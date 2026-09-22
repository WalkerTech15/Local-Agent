/**
 * The Windows automation executor (Phase 2, Milestone 10).
 *
 * `runAutomationTool` turns one fixed registry entry
 * (`shared/automation/registry.ts`) into a real desktop action. It is the
 * only function in this codebase that does so, and it can only act on a
 * {@link AutomationToolDefinition} — never a path, a URL or a command string
 * a caller supplied, because no such field exists on that type.
 *
 * ## No shell, ever
 *
 * `launchDetached` calls `spawn` with `shell: false`, exactly as
 * `main/process-runner.ts` does. There is no `cmd.exe`, no `powershell.exe`
 * and no batch-file indirection anywhere in this module: every `launch-app`
 * and `run-script` entry names a literal `.exe` under `%SystemRoot%\System32`,
 * resolved by {@link resolveSystem32Executable} and nothing else.
 *
 * ## Launching is not waiting
 *
 * Unlike `runProcess`, which runs a build tool to completion and reports its
 * exit code, `launchDetached` starts a GUI program the user expects to keep
 * running — Notepad staying open is success, not a hang. So it does not wait
 * for the child to exit: it waits out a short grace window
 * (`AUTOMATION_LAUNCH_TIMEOUT_MS`) to catch an immediate failure (a missing
 * executable, an instant crash), then reports success and leaves the process
 * running, detached from this application's own lifetime. Cancelling an
 * automation run therefore only ever abandons a *launch attempt in
 * progress* — it deliberately never kills a program that already started,
 * because a user who opened Notepad did not ask Local Agent to be able to
 * close it again.
 *
 * ## Dependency injection at the Electron boundary
 *
 * `open-folder`, `open-website` and `focus-window` all need a live Electron
 * module (`shell`, `app`, the real `BrowserWindow`) that only exists inside a
 * running application. Exactly like `main/confirm.ts` and
 * `main/directory-picker.ts`, those calls are not made here: `main/index.ts`
 * builds the real callbacks once, from the real `electron` module, and passes
 * them in as {@link AutomationRunDependencies}. This module never imports
 * `electron` itself, which is what lets its own tests run under plain Node.
 */

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { AutomationError } from '../shared/automation/errors';
import type { AutomationToolDefinition } from '../shared/automation/registry';
import { isSafeAutomationUrl } from '../shared/automation/validation';
import {
  AUTOMATION_LAUNCH_TIMEOUT_MS,
  AUTOMATION_MAX_ATTEMPTS,
  AUTOMATION_SHELL_TIMEOUT_MS,
} from '../shared/constants';

export interface LaunchOptions {
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

/** `started` is false for both a launch failure and an abandoned attempt. */
export interface LaunchOutcome {
  readonly started: boolean;
}

export interface AutomationRunDependencies {
  /** Starts a detached process. The real implementation is {@link launchDetached}. */
  readonly launchProcess: (
    executablePath: string,
    args: readonly string[],
    options: LaunchOptions,
  ) => Promise<LaunchOutcome>;
  /** `shell.openPath`. Resolves to `''` on success, or a short OS error string. */
  readonly openPath: (path: string) => Promise<string>;
  /** `shell.openExternal`. Rejects on failure. */
  readonly openExternal: (url: string) => Promise<void>;
  /** `app.getPath`, narrowed to the three special folders this milestone offers. */
  readonly getSpecialFolder: (name: 'desktop' | 'documents' | 'downloads') => string;
  /** Brings the application's own window to the foreground. False if there is none. */
  readonly focusMainWindow: () => boolean;
}

export interface RunAutomationToolOptions {
  readonly tool: AutomationToolDefinition;
  /** The approved project's root, or `null` when none is open this session. */
  readonly projectRoot: string | null;
  /** `process.env.SystemRoot`, resolved by the caller so this stays testable. */
  readonly systemRoot: string;
  readonly signal: AbortSignal;
  readonly isEmergencyEngaged: () => Promise<boolean>;
  readonly dependencies: AutomationRunDependencies;
}

export interface AutomationRunOutcome {
  /** How many launch attempts this run made. Always 1 for every kind but `launch-app`/`run-script`. */
  readonly attempts: number;
}

/** `%SystemRoot%\System32\<executable>` — never a path from a request. */
export function resolveSystem32Executable(executable: string, systemRoot: string): string {
  return join(systemRoot, 'System32', executable);
}

/**
 * Starts a detached process and waits out a grace window for an immediate
 * failure, without waiting for the process to exit. See the module doc.
 *
 * Never throws: a process that could not be started is a reported outcome,
 * exactly as `runProcess` treats a non-zero exit as a result rather than an
 * error. Only a program that fails to *start at all* is `started: false`.
 */
export function launchDetached(
  executablePath: string,
  args: readonly string[],
  options: LaunchOptions,
): Promise<LaunchOutcome> {
  return new Promise<LaunchOutcome>((resolvePromise) => {
    let settled = false;
    let child: ChildProcess;

    try {
      child = spawn(executablePath, [...args], {
        detached: true,
        stdio: 'ignore',
        shell: false,
        windowsHide: false,
      });
    } catch {
      resolvePromise({ started: false });
      return;
    }

    function settle(started: boolean): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
      child.removeAllListeners();
      if (started) child.unref();
      resolvePromise({ started });
    }

    // The grace window elapsing without an error or an immediate exit is
    // success: the process is presumed to be running normally, and is left
    // to do so.
    const timer = setTimeout(() => {
      settle(true);
    }, options.timeoutMs);
    timer.unref();

    function onAbort(): void {
      // The attempt is abandoned; the process, if it already started, is
      // deliberately not killed — see the module doc.
      settle(false);
    }
    options.signal.addEventListener('abort', onAbort, { once: true });

    child.once('error', () => {
      settle(false);
    });

    // A program that exits within the grace window with a nonzero code (a
    // bad argument, an instant crash) is a launch failure, not a success.
    child.once('exit', (code) => {
      settle(code === 0 || code === null);
    });
  });
}

async function precheck(
  signal: AbortSignal,
  isEmergencyEngaged: () => Promise<boolean>,
): Promise<void> {
  if (signal.aborted) throw new AutomationError('AUTOMATION_CANCELLED');
  if (await isEmergencyEngaged()) throw new AutomationError('AUTOMATION_EMERGENCY_STOPPED');
}

/**
 * Races `operation` against a timeout and the run's own cancellation signal.
 *
 * Used only for `open-folder` and `open-website`, which hand off to the OS
 * shell and are expected to settle almost immediately — unlike a launched GUI
 * application, there is no reason for either to still be pending after
 * `AUTOMATION_SHELL_TIMEOUT_MS`.
 */
function withTimeout<T>(operation: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new AutomationError('AUTOMATION_CANCELLED'));

  return new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectPromise(new AutomationError('AUTOMATION_TIMEOUT'));
    }, timeoutMs);
    timer.unref();

    function onAbort(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(new AutomationError('AUTOMATION_CANCELLED'));
    }
    signal.addEventListener('abort', onAbort, { once: true });

    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolvePromise(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        rejectPromise(
          error instanceof Error ? error : new AutomationError('AUTOMATION_VERIFICATION_FAILED'),
        );
      },
    );
  });
}

async function runAppOrScript(
  tool: Extract<AutomationToolDefinition, { kind: 'launch-app' | 'run-script' }>,
  options: RunAutomationToolOptions,
): Promise<AutomationRunOutcome> {
  const executablePath = resolveSystem32Executable(tool.executable, options.systemRoot);

  for (let attempts = 1; attempts <= AUTOMATION_MAX_ATTEMPTS; attempts += 1) {
    await precheck(options.signal, options.isEmergencyEngaged);

    const outcome = await options.dependencies.launchProcess(executablePath, tool.args, {
      timeoutMs: AUTOMATION_LAUNCH_TIMEOUT_MS,
      signal: options.signal,
    });

    if (outcome.started) return { attempts };
    if (options.signal.aborted) throw new AutomationError('AUTOMATION_CANCELLED');
  }

  throw new AutomationError('AUTOMATION_LAUNCH_FAILED');
}

async function runOpenFolder(
  tool: Extract<AutomationToolDefinition, { kind: 'open-folder' }>,
  options: RunAutomationToolOptions,
): Promise<AutomationRunOutcome> {
  await precheck(options.signal, options.isEmergencyEngaged);

  let target: string;
  if (tool.folder === 'project') {
    if (options.projectRoot === null) throw new AutomationError('AUTOMATION_NO_PROJECT');
    target = options.projectRoot;
  } else {
    target = options.dependencies.getSpecialFolder(tool.folder);
  }

  const errorText = await withTimeout(
    options.dependencies.openPath(target),
    AUTOMATION_SHELL_TIMEOUT_MS,
    options.signal,
  );
  if (errorText.length > 0) throw new AutomationError('AUTOMATION_VERIFICATION_FAILED');
  return { attempts: 1 };
}

async function runOpenWebsite(
  tool: Extract<AutomationToolDefinition, { kind: 'open-website' }>,
  options: RunAutomationToolOptions,
): Promise<AutomationRunOutcome> {
  await precheck(options.signal, options.isEmergencyEngaged);

  if (!isSafeAutomationUrl(tool.url)) throw new AutomationError('AUTOMATION_LAUNCH_FAILED');

  await withTimeout(
    options.dependencies.openExternal(tool.url),
    AUTOMATION_SHELL_TIMEOUT_MS,
    options.signal,
  ).catch((error: unknown) => {
    if (error instanceof AutomationError) throw error;
    throw new AutomationError('AUTOMATION_VERIFICATION_FAILED');
  });
  return { attempts: 1 };
}

async function runFocusWindow(options: RunAutomationToolOptions): Promise<AutomationRunOutcome> {
  await precheck(options.signal, options.isEmergencyEngaged);
  if (!options.dependencies.focusMainWindow()) {
    throw new AutomationError('AUTOMATION_VERIFICATION_FAILED');
  }
  return { attempts: 1 };
}

/**
 * Performs exactly one registered automation tool.
 *
 * Throws {@link AutomationError} for every refusal and every failure —
 * `main/ipc.ts` maps its `code` onto the normalized IPC response, exactly as
 * it already does for a `WorkflowError` or a `WorkspaceError`. A resolved
 * promise means the action reached a verified success state; there is no
 * partial or ambiguous outcome.
 */
export async function runAutomationTool(
  options: RunAutomationToolOptions,
): Promise<AutomationRunOutcome> {
  const { tool } = options;
  if (tool.requiresProject && options.projectRoot === null) {
    throw new AutomationError('AUTOMATION_NO_PROJECT');
  }

  switch (tool.kind) {
    case 'launch-app':
    case 'run-script':
      return runAppOrScript(tool, options);
    case 'open-folder':
      return runOpenFolder(tool, options);
    case 'open-website':
      return runOpenWebsite(tool, options);
    case 'focus-window':
      return runFocusWindow(options);
  }
}
