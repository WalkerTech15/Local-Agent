import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  launchDetached,
  resolveSystem32Executable,
  runAutomationTool,
} from '../../../src/main/windows-automation';
import type {
  AutomationRunDependencies,
  LaunchOutcome,
} from '../../../src/main/windows-automation';
import { AutomationError } from '../../../src/shared/automation/errors';
import { findAutomationTool } from '../../../src/shared/automation/registry';
import type { AutomationToolDefinition } from '../../../src/shared/automation/registry';

const NODE = process.execPath;
/**
 * How long the "nothing happened" case actually waits out its grace window —
 * kept short so that one test does not slow the suite down.
 */
const SHORT_TIMEOUT = 200;
/**
 * The grace window for cases expected to settle quickly via a real event
 * (an 'error' or an 'exit'), not by timing out. Generous rather than tight:
 * a loaded machine can take longer than {@link SHORT_TIMEOUT} to deliver the
 * event, which would otherwise make "exited immediately" indistinguishable
 * from "the grace window merely elapsed" and make the test flaky.
 */
const EVENT_TIMEOUT = 5_000;

function neverEngaged(): Promise<boolean> {
  return Promise.resolve(false);
}

function requireTool(id: string): AutomationToolDefinition {
  const tool = findAutomationTool(id);
  if (tool === null) throw new Error(`unknown tool: ${id}`);
  return tool;
}

// ---------------------------------------------------------------------------
// resolveSystem32Executable
// ---------------------------------------------------------------------------

describe('resolveSystem32Executable', () => {
  it('joins the system root, System32 and the literal executable name', () => {
    expect(resolveSystem32Executable('notepad.exe', 'C:\\Windows')).toBe(
      'C:\\Windows\\System32\\notepad.exe',
    );
  });
});

// ---------------------------------------------------------------------------
// launchDetached — every case spawns a real process, exactly like
// process-runner.test.ts, because whether an 'error' event fires, whether an
// early exit is observed and whether abort lands are not behaviours a fake
// child process can have.
// ---------------------------------------------------------------------------

describe('launchDetached', () => {
  it('reports success once the grace window elapses without incident', async () => {
    const controller = new AbortController();
    const outcome = await launchDetached(NODE, [], {
      timeoutMs: SHORT_TIMEOUT,
      signal: controller.signal,
    });
    expect(outcome.started).toBe(true);
  });

  it('reports failure when the executable does not exist', async () => {
    const controller = new AbortController();
    const outcome = await launchDetached('C:\\definitely\\not\\a\\real\\program.exe', [], {
      timeoutMs: EVENT_TIMEOUT,
      signal: controller.signal,
    });
    expect(outcome.started).toBe(false);
  });

  it('reports failure when the process exits immediately with a nonzero code', async () => {
    const controller = new AbortController();
    const outcome = await launchDetached(NODE, ['-e', 'process.exit(1)'], {
      timeoutMs: EVENT_TIMEOUT,
      signal: controller.signal,
    });
    expect(outcome.started).toBe(false);
  });

  it('reports success when the process exits immediately with code zero', async () => {
    const controller = new AbortController();
    const outcome = await launchDetached(NODE, ['-e', 'process.exit(0)'], {
      timeoutMs: EVENT_TIMEOUT,
      signal: controller.signal,
    });
    expect(outcome.started).toBe(true);
  });

  it('abandons the attempt when cancelled before the grace window elapses', async () => {
    const controller = new AbortController();
    const promise = launchDetached(NODE, [], {
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    controller.abort();
    const outcome = await promise;
    expect(outcome.started).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runAutomationTool — orchestration, tested against injected dependencies so
// retries, timeouts, cancellation, emergency stop and kind dispatch are all
// deterministic and fast.
// ---------------------------------------------------------------------------

function fakeDependencies(
  overrides: Partial<AutomationRunDependencies> = {},
): AutomationRunDependencies {
  return {
    launchProcess: () => Promise.resolve<LaunchOutcome>({ started: true }),
    openPath: () => Promise.resolve(''),
    openExternal: () => Promise.resolve(),
    getSpecialFolder: () => 'C:\\Users\\fake\\Desktop',
    focusMainWindow: () => true,
    ...overrides,
  };
}

describe('runAutomationTool — launch-app and run-script', () => {
  it('succeeds on the first attempt', async () => {
    const controller = new AbortController();
    const outcome = await runAutomationTool({
      tool: requireTool('app.notepad'),
      projectRoot: null,
      systemRoot: 'C:\\Windows',
      signal: controller.signal,
      isEmergencyEngaged: neverEngaged,
      dependencies: fakeDependencies(),
    });
    expect(outcome.attempts).toBe(1);
  });

  it('retries up to the bound, then succeeds', async () => {
    let calls = 0;
    const controller = new AbortController();
    const outcome = await runAutomationTool({
      tool: requireTool('app.notepad'),
      projectRoot: null,
      systemRoot: 'C:\\Windows',
      signal: controller.signal,
      isEmergencyEngaged: neverEngaged,
      dependencies: fakeDependencies({
        launchProcess: () => {
          calls += 1;
          return Promise.resolve<LaunchOutcome>({ started: calls >= 3 });
        },
      }),
    });
    expect(outcome.attempts).toBe(3);
  });

  it('gives up after the retry bound and reports a launch failure', async () => {
    const controller = new AbortController();
    await expect(
      runAutomationTool({
        tool: requireTool('app.notepad'),
        projectRoot: null,
        systemRoot: 'C:\\Windows',
        signal: controller.signal,
        isEmergencyEngaged: neverEngaged,
        dependencies: fakeDependencies({
          launchProcess: () => Promise.resolve({ started: false }),
        }),
      }),
    ).rejects.toMatchObject({ code: 'AUTOMATION_LAUNCH_FAILED' });
  });

  it('stops retrying once cancelled mid-run rather than exhausting the retry bound', async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(
      runAutomationTool({
        tool: requireTool('script.task-manager'),
        projectRoot: null,
        systemRoot: 'C:\\Windows',
        signal: controller.signal,
        isEmergencyEngaged: neverEngaged,
        dependencies: fakeDependencies({
          launchProcess: () => {
            calls += 1;
            controller.abort();
            return Promise.resolve<LaunchOutcome>({ started: false });
          },
        }),
      }),
    ).rejects.toMatchObject({ code: 'AUTOMATION_CANCELLED' });
    expect(calls).toBe(1);
  });

  it('never starts a process while the emergency stop is engaged', async () => {
    const controller = new AbortController();
    const launchProcess = vi.fn(() => Promise.resolve<LaunchOutcome>({ started: true }));
    await expect(
      runAutomationTool({
        tool: requireTool('app.notepad'),
        projectRoot: null,
        systemRoot: 'C:\\Windows',
        signal: controller.signal,
        isEmergencyEngaged: () => Promise.resolve(true),
        dependencies: fakeDependencies({ launchProcess }),
      }),
    ).rejects.toMatchObject({ code: 'AUTOMATION_EMERGENCY_STOPPED' });
    expect(launchProcess).not.toHaveBeenCalled();
  });

  it('never starts a process when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const launchProcess = vi.fn(() => Promise.resolve<LaunchOutcome>({ started: true }));
    await expect(
      runAutomationTool({
        tool: requireTool('app.notepad'),
        projectRoot: null,
        systemRoot: 'C:\\Windows',
        signal: controller.signal,
        isEmergencyEngaged: neverEngaged,
        dependencies: fakeDependencies({ launchProcess }),
      }),
    ).rejects.toMatchObject({ code: 'AUTOMATION_CANCELLED' });
    expect(launchProcess).not.toHaveBeenCalled();
  });
});

describe('runAutomationTool — open-folder', () => {
  it('succeeds when the shell reports no error', async () => {
    const controller = new AbortController();
    const outcome = await runAutomationTool({
      tool: requireTool('folder.desktop'),
      projectRoot: null,
      systemRoot: 'C:\\Windows',
      signal: controller.signal,
      isEmergencyEngaged: neverEngaged,
      dependencies: fakeDependencies(),
    });
    expect(outcome.attempts).toBe(1);
  });

  it('reports a verification failure when the shell returns an error string', async () => {
    const controller = new AbortController();
    await expect(
      runAutomationTool({
        tool: requireTool('folder.desktop'),
        projectRoot: null,
        systemRoot: 'C:\\Windows',
        signal: controller.signal,
        isEmergencyEngaged: neverEngaged,
        dependencies: fakeDependencies({ openPath: () => Promise.resolve('no such folder') }),
      }),
    ).rejects.toMatchObject({ code: 'AUTOMATION_VERIFICATION_FAILED' });
  });

  it('opens the approved project root for the project folder tool', async () => {
    const controller = new AbortController();
    const openPath = vi.fn(() => Promise.resolve(''));
    await runAutomationTool({
      tool: requireTool('folder.project'),
      projectRoot: 'C:\\Users\\fake\\project',
      systemRoot: 'C:\\Windows',
      signal: controller.signal,
      isEmergencyEngaged: neverEngaged,
      dependencies: fakeDependencies({ openPath }),
    });
    expect(openPath).toHaveBeenCalledWith('C:\\Users\\fake\\project');
  });

  it('refuses the project folder tool when no project is approved', async () => {
    const controller = new AbortController();
    await expect(
      runAutomationTool({
        tool: requireTool('folder.project'),
        projectRoot: null,
        systemRoot: 'C:\\Windows',
        signal: controller.signal,
        isEmergencyEngaged: neverEngaged,
        dependencies: fakeDependencies(),
      }),
    ).rejects.toMatchObject({ code: 'AUTOMATION_NO_PROJECT' });
  });
});

describe('runAutomationTool — open-website', () => {
  it('succeeds when the shell opens the URL without error', async () => {
    const controller = new AbortController();
    const outcome = await runAutomationTool({
      tool: requireTool('website.github'),
      projectRoot: null,
      systemRoot: 'C:\\Windows',
      signal: controller.signal,
      isEmergencyEngaged: neverEngaged,
      dependencies: fakeDependencies(),
    });
    expect(outcome.attempts).toBe(1);
  });

  it('refuses a URL outside the allowed hosts before ever calling the shell', async () => {
    const controller = new AbortController();
    const openExternal = vi.fn(() => Promise.resolve());
    const unsafeTool: AutomationToolDefinition = {
      id: 'website.github',
      kind: 'open-website',
      label: 'Evil',
      description: 'test double',
      actionType: 'automation.run',
      requiresProject: false,
      url: 'https://evil.example.com',
    };
    await expect(
      runAutomationTool({
        tool: unsafeTool,
        projectRoot: null,
        systemRoot: 'C:\\Windows',
        signal: controller.signal,
        isEmergencyEngaged: neverEngaged,
        dependencies: fakeDependencies({ openExternal }),
      }),
    ).rejects.toMatchObject({ code: 'AUTOMATION_LAUNCH_FAILED' });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('reports a verification failure when the shell rejects', async () => {
    const controller = new AbortController();
    await expect(
      runAutomationTool({
        tool: requireTool('website.github'),
        projectRoot: null,
        systemRoot: 'C:\\Windows',
        signal: controller.signal,
        isEmergencyEngaged: neverEngaged,
        dependencies: fakeDependencies({ openExternal: () => Promise.reject(new Error('nope')) }),
      }),
    ).rejects.toMatchObject({ code: 'AUTOMATION_VERIFICATION_FAILED' });
  });

  it('is cancellable while waiting on the shell', async () => {
    const controller = new AbortController();
    const pending = new Promise<void>(() => {
      // Never resolves; the run must finish via cancellation instead.
    });
    const promise = runAutomationTool({
      tool: requireTool('website.github'),
      projectRoot: null,
      systemRoot: 'C:\\Windows',
      signal: controller.signal,
      isEmergencyEngaged: neverEngaged,
      dependencies: fakeDependencies({ openExternal: () => pending }),
    });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: 'AUTOMATION_CANCELLED' });
  });
});

describe('runAutomationTool — focus-window', () => {
  it('succeeds when the window is focused', async () => {
    const controller = new AbortController();
    const outcome = await runAutomationTool({
      tool: requireTool('window.local-agent'),
      projectRoot: null,
      systemRoot: 'C:\\Windows',
      signal: controller.signal,
      isEmergencyEngaged: neverEngaged,
      dependencies: fakeDependencies(),
    });
    expect(outcome.attempts).toBe(1);
  });

  it('reports a verification failure when there is no window to focus', async () => {
    const controller = new AbortController();
    await expect(
      runAutomationTool({
        tool: requireTool('window.local-agent'),
        projectRoot: null,
        systemRoot: 'C:\\Windows',
        signal: controller.signal,
        isEmergencyEngaged: neverEngaged,
        dependencies: fakeDependencies({ focusMainWindow: () => false }),
      }),
    ).rejects.toMatchObject({ code: 'AUTOMATION_VERIFICATION_FAILED' });
  });
});

describe('runAutomationTool — timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('times out a shell call that never settles', async () => {
    const controller = new AbortController();
    const pending = new Promise<string>(() => {
      // Never resolves.
    });
    const promise = runAutomationTool({
      tool: requireTool('folder.desktop'),
      projectRoot: null,
      systemRoot: 'C:\\Windows',
      signal: controller.signal,
      isEmergencyEngaged: neverEngaged,
      dependencies: fakeDependencies({ openPath: () => pending }),
    });
    const assertion = expect(promise).rejects.toMatchObject({ code: 'AUTOMATION_TIMEOUT' });
    await vi.runAllTimersAsync();
    await assertion;
  });
});

describe('AutomationError', () => {
  it('is what every refusal in this module throws', () => {
    expect(new AutomationError('AUTOMATION_TOOL_NOT_FOUND')).toBeInstanceOf(Error);
  });
});
