import { describe, expect, it, vi } from 'vitest';

import { AutomationController } from '../../../src/renderer/automation/automation-controller';
import type {
  AutomationClient,
  AutomationResult,
} from '../../../src/renderer/automation/ipc-automation-client';
import type { AutomationErrorCode } from '../../../src/shared/automation';
import type {
  AutomationCatalog,
  AutomationRunResult,
  AutomationTool,
} from '../../../src/shared/schemas';

/**
 * The Automation panel's state machine, driven directly.
 *
 * React Testing Library and jsdom are not part of this project's toolchain,
 * so the behaviours a person actually experiences — loading, error, retry,
 * staleness, declining, cancelling — are tested here rather than through a
 * rendered component. Mirrors `tests/unit/renderer/workflow-controller.test.ts`.
 */

const RUN_ID = '11111111-1111-4111-8111-111111111111';

function tool(overrides: Partial<AutomationTool> = {}): AutomationTool {
  return {
    id: 'app.notepad',
    kind: 'launch-app',
    label: 'Notepad',
    description: 'Opens the Windows text editor.',
    requiresProject: false,
    ...overrides,
  };
}

function catalog(overrides: Partial<AutomationCatalog> = {}): AutomationCatalog {
  return { tools: [tool()], busy: false, ...overrides };
}

function runResult(overrides: Partial<AutomationRunResult> = {}): AutomationRunResult {
  return {
    runId: RUN_ID,
    toolId: 'app.notepad',
    kind: 'launch-app',
    outcome: 'succeeded',
    startedAt: '2026-09-16T00:00:00.000Z',
    finishedAt: '2026-09-16T00:00:00.000Z',
    durationMs: 100,
    attempts: 1,
    timedOut: false,
    cancelled: false,
    stoppedByEmergency: false,
    verified: true,
    ...overrides,
  };
}

function ok<TValue>(value: TValue): AutomationResult<TValue> {
  return { ok: true, value };
}

function fails<TValue>(code: AutomationErrorCode): AutomationResult<TValue> {
  return { ok: false, failure: { kind: 'error', code } };
}

function denied<TValue>(): AutomationResult<TValue> {
  return { ok: false, failure: { kind: 'denied' } };
}

function declined<TValue>(): AutomationResult<TValue> {
  return { ok: false, failure: { kind: 'declined' } };
}

function fakeClient(overrides: Partial<AutomationClient> = {}): AutomationClient {
  return {
    list: () => Promise.resolve(ok(catalog())),
    run: () => Promise.resolve(ok(runResult())),
    cancel: () => Promise.resolve(),
    ...overrides,
  };
}

describe('initial state', () => {
  it('starts uninitialised, idle and empty', () => {
    const state = new AutomationController({ client: fakeClient() }).getState();
    expect(state.initialized).toBe(false);
    expect(state.tools).toEqual([]);
    expect(state.busy).toBeNull();
    expect(state.lastRun).toBeNull();
    expect(state.error).toBeNull();
  });

  it('loads on initialize and marks itself initialised', async () => {
    const controller = new AutomationController({ client: fakeClient() });
    await controller.initialize();
    const state = controller.getState();
    expect(state.initialized).toBe(true);
    expect(state.tools).toEqual([tool()]);
  });

  it('marks itself initialised even when the first load fails', async () => {
    const controller = new AutomationController({
      client: fakeClient({ list: () => Promise.resolve(fails('AUTOMATION_RUN_FAILED')) }),
    });
    await controller.initialize();
    expect(controller.getState().initialized).toBe(true);
    expect(controller.getState().error).not.toBeNull();
  });

  it('does not load twice', async () => {
    const list = vi.fn(() => Promise.resolve(ok(catalog())));
    const controller = new AutomationController({ client: fakeClient({ list }) });
    await controller.initialize();
    await controller.initialize();
    expect(list).toHaveBeenCalledTimes(1);
  });
});

describe('running a tool', () => {
  it('reports the tool as running until the client resolves', async () => {
    const controller = new AutomationController({
      client: fakeClient({ run: () => Promise.resolve(ok(runResult())) }),
      newRunId: () => RUN_ID,
    });
    const promise = controller.runTool('app.notepad');
    expect(controller.getState().runningToolId).toBe('app.notepad');
    expect(controller.getState().busy).toBe('run');
    await promise;
    expect(controller.getState().runningToolId).toBeNull();
    expect(controller.getState().busy).toBeNull();
  });

  it('records the last run on success', async () => {
    const controller = new AutomationController({
      client: fakeClient({ run: () => Promise.resolve(ok(runResult({ outcome: 'succeeded' }))) }),
    });
    await controller.runTool('app.notepad');
    expect(controller.getState().lastRun?.outcome).toBe('succeeded');
    expect(controller.getState().error).toBeNull();
  });

  it('refuses to start a second run while one is in flight', async () => {
    const run = vi.fn(() => Promise.resolve(ok(runResult())));
    const controller = new AutomationController({ client: fakeClient({ run }) });
    const first = controller.runTool('app.notepad');
    await controller.runTool('app.calculator');
    await first;
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('reports a denial as an error banner, not an activity note', async () => {
    const controller = new AutomationController({
      client: fakeClient({ run: () => Promise.resolve(denied()) }),
    });
    await controller.runTool('app.notepad');
    const state = controller.getState();
    expect(state.error?.retryable).toBe(false);
    expect(state.activity).toBeNull();
  });

  it('reports a declined confirmation as an activity note, not an error', async () => {
    const controller = new AutomationController({
      client: fakeClient({ run: () => Promise.resolve(declined()) }),
    });
    await controller.runTool('app.notepad');
    const state = controller.getState();
    expect(state.error).toBeNull();
    expect(state.activity).toContain('declined');
  });

  it('marks a verification failure as retryable and a not-found tool as not retryable', async () => {
    const retryable = new AutomationController({
      client: fakeClient({ run: () => Promise.resolve(fails('AUTOMATION_VERIFICATION_FAILED')) }),
    });
    await retryable.runTool('app.notepad');
    expect(retryable.getState().error?.retryable).toBe(true);

    const notRetryable = new AutomationController({
      client: fakeClient({ run: () => Promise.resolve(fails('AUTOMATION_TOOL_NOT_FOUND')) }),
    });
    await notRetryable.runTool('app.notepad');
    expect(notRetryable.getState().error?.retryable).toBe(false);
  });

  it('never shows a message the client did not provide through the closed error code', async () => {
    const controller = new AutomationController({
      client: fakeClient({ run: () => Promise.resolve(fails('AUTOMATION_EMERGENCY_STOPPED')) }),
    });
    await controller.runTool('app.notepad');
    const message = controller.getState().error?.message ?? '';
    expect(message).not.toContain('AUTOMATION_EMERGENCY_STOPPED');
    expect(message.length).toBeGreaterThan(0);
  });
});

describe('staleness', () => {
  it('discards a response that arrives after the controller was disposed', async () => {
    const captured: { release: ((value: AutomationResult<AutomationCatalog>) => void) | null } = {
      release: null,
    };
    const stale = new Promise<AutomationResult<AutomationCatalog>>((resolvePromise) => {
      captured.release = resolvePromise;
    });

    const controller = new AutomationController({ client: fakeClient({ list: () => stale }) });
    const pendingInit = controller.initialize();
    controller.dispose();
    captured.release?.(ok(catalog()));
    await pendingInit;

    expect(controller.getState().tools).toEqual([]);
  });

  it('stops notifying listeners once disposed', async () => {
    const listener = vi.fn();
    const controller = new AutomationController({ client: fakeClient() });
    controller.subscribe(listener);
    controller.dispose();
    await controller.initialize();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('cancel', () => {
  it('does nothing when no run is in flight', async () => {
    const cancel = vi.fn(() => Promise.resolve());
    const controller = new AutomationController({ client: fakeClient({ cancel }) });
    await controller.cancelRun();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('asks the client to cancel the running run', async () => {
    const captured: {
      resolveRun: ((value: AutomationResult<AutomationRunResult>) => void) | null;
    } = {
      resolveRun: null,
    };
    const pending = new Promise<AutomationResult<AutomationRunResult>>((resolvePromise) => {
      captured.resolveRun = resolvePromise;
    });
    const cancel = vi.fn(() => Promise.resolve());
    const controller = new AutomationController({
      client: fakeClient({ run: () => pending, cancel }),
      newRunId: () => RUN_ID,
    });

    const running = controller.runTool('app.notepad');
    await controller.cancelRun();
    expect(cancel).toHaveBeenCalledWith(RUN_ID);

    captured.resolveRun?.(ok(runResult({ outcome: 'stopped', cancelled: true })));
    await running;
  });
});

describe('retry', () => {
  it('repeats the last failed operation', async () => {
    const list = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(fails('AUTOMATION_RUN_FAILED')))
      .mockImplementationOnce(() => Promise.resolve(ok(catalog())));
    const controller = new AutomationController({ client: fakeClient({ list }) });

    await controller.refresh();
    expect(controller.getState().error).not.toBeNull();

    await controller.retry();
    expect(list).toHaveBeenCalledTimes(2);
    expect(controller.getState().error).toBeNull();
  });

  it('does nothing when there is nothing to retry', async () => {
    const controller = new AutomationController({ client: fakeClient() });
    await controller.retry();
    expect(controller.getState().busy).toBeNull();
  });
});

describe('dismissError', () => {
  it('clears the error without touching anything else', async () => {
    const controller = new AutomationController({
      client: fakeClient({ list: () => Promise.resolve(fails('AUTOMATION_RUN_FAILED')) }),
    });
    await controller.refresh();
    expect(controller.getState().error).not.toBeNull();
    controller.dismissError();
    expect(controller.getState().error).toBeNull();
  });
});
