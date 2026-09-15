import { describe, expect, it, vi } from 'vitest';

import { WorkflowController } from '../../../src/renderer/workflow/workflow-controller';
import type {
  WorkflowClient,
  WorkflowResult,
} from '../../../src/renderer/workflow/ipc-workflow-client';
import type { WorkflowErrorCode } from '../../../src/shared/workflow';
import type {
  Workflow,
  WorkflowInput,
  WorkflowProgressEvent,
  WorkflowRun,
} from '../../../src/shared/schemas';

/**
 * The Workflow Dashboard's state machine, driven directly.
 *
 * React Testing Library and jsdom are not part of this project's toolchain,
 * so the behaviours a person actually experiences — loading, empty, error,
 * retry, live progress, awaiting-confirmation, pause, cancel — are tested
 * here rather than through a rendered component.
 */

const NOW = '2026-09-14T00:00:00.000Z';
const RUN_ID = '11111111-1111-4111-8111-111111111111';

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'nightly.check',
    name: 'Nightly check',
    description: '',
    trigger: 'manual',
    agentProfileId: 'reviewer',
    steps: [
      {
        tool: 'workspace.inspect',
        target: '',
        query: null,
        condition: 'always',
        maxRetries: 0,
        checkpoint: false,
      },
    ],
    limits: { maxSteps: 8, maxDurationMs: 60_000, maxOutputBytes: 50_000 },
    failureBehavior: 'stop',
    rollback: 'none',
    successCriteria: { verification: [], requireAllStepsSucceed: true },
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const INPUT: WorkflowInput = (() => {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...input } = workflow();
  return input;
})();

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    runId: RUN_ID,
    workflowId: 'nightly.check',
    workflowName: 'Nightly check',
    agentProfileId: 'reviewer',
    provider: 'none',
    status: 'completed',
    stopReason: 'completed',
    startedAt: NOW,
    finishedAt: NOW,
    steps: [],
    verification: { required: [], satisfied: [], passed: true },
    rollback: { mode: 'none', result: 'not-configured', restored: 0 },
    totals: { steps: 0, outputBytes: 0, durationMs: 0 },
    ...overrides,
  };
}

function ok<TValue>(value: TValue): WorkflowResult<TValue> {
  return { ok: true, value };
}

function fails<TValue>(code: WorkflowErrorCode): WorkflowResult<TValue> {
  return { ok: false, failure: { kind: 'error', code } };
}

/** A client whose every operation succeeds, with a capturable progress hook. */
function fakeClient(overrides: Partial<WorkflowClient> = {}): WorkflowClient {
  return {
    list: () => Promise.resolve(ok([])),
    create: () => Promise.resolve(ok([workflow()])),
    update: () => Promise.resolve(ok([workflow()])),
    duplicate: () => Promise.resolve(ok([workflow()])),
    remove: () => Promise.resolve(ok([])),
    setEnabled: () => Promise.resolve(ok([workflow({ enabled: false })])),
    run: () => Promise.resolve(ok(run())),
    pause: () => Promise.resolve(),
    cancel: () => Promise.resolve(),
    onProgress: () => () => undefined,
    ...overrides,
  };
}

/** Captures the progress listener so a test can push events at the controller. */
function progressHarness(): {
  client: WorkflowClient;
  emit: (event: WorkflowProgressEvent) => void;
  unsubscribed: () => boolean;
} {
  let listener: ((event: WorkflowProgressEvent) => void) | null = null;
  let unsubscribed = false;

  const client = fakeClient({
    onProgress: (next) => {
      listener = next;
      return () => {
        unsubscribed = true;
      };
    },
  });

  return {
    client,
    emit: (event) => {
      listener?.(event);
    },
    unsubscribed: () => unsubscribed,
  };
}

function progressEvent(overrides: Partial<WorkflowProgressEvent> = {}): WorkflowProgressEvent {
  return {
    runId: RUN_ID,
    phase: 'step-started',
    stepIndex: 0,
    attempt: 1,
    tool: 'workspace.inspect',
    totalSteps: 2,
    completedSteps: 0,
    outcome: null,
    ...overrides,
  };
}

describe('initial state', () => {
  it('starts uninitialised, idle and empty', () => {
    const state = new WorkflowController({ client: fakeClient() }).getState();
    expect(state.initialized).toBe(false);
    expect(state.workflows).toEqual([]);
    expect(state.busy).toBeNull();
    expect(state.run).toBeNull();
    expect(state.progress).toBeNull();
  });

  it('loads on initialize and marks itself initialised even when empty', async () => {
    const controller = new WorkflowController({ client: fakeClient() });
    await controller.initialize();
    expect(controller.getState().initialized).toBe(true);
  });

  it('marks itself initialised even when the first load fails', async () => {
    const controller = new WorkflowController({
      client: fakeClient({ list: () => Promise.resolve(fails('WORKFLOW_STORE_FAILED')) }),
    });
    await controller.initialize();
    expect(controller.getState().initialized).toBe(true);
    expect(controller.getState().error).not.toBeNull();
  });

  it('does not load twice', async () => {
    const list = vi.fn(() => Promise.resolve(ok([])));
    const controller = new WorkflowController({ client: fakeClient({ list }) });
    await controller.initialize();
    await controller.initialize();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('subscribes to progress once, and unsubscribes when disposed', async () => {
    const harness = progressHarness();
    const controller = new WorkflowController({ client: harness.client });
    await controller.initialize();
    expect(harness.unsubscribed()).toBe(false);
    controller.dispose();
    expect(harness.unsubscribed()).toBe(true);
  });
});

describe('the workflow list', () => {
  it('shows what a list returned', async () => {
    const controller = new WorkflowController({
      client: fakeClient({ list: () => Promise.resolve(ok([workflow()])) }),
    });
    await controller.initialize();
    expect(controller.getState().workflows).toHaveLength(1);
  });

  it('reports each write in its own words', async () => {
    const controller = new WorkflowController({ client: fakeClient() });
    await controller.initialize();

    await controller.createWorkflow(INPUT);
    expect(controller.getState().activity).toBe('Workflow created.');

    await controller.duplicateWorkflow('nightly.check', 'nightly.copy');
    expect(controller.getState().activity).toContain('copy is disabled');

    await controller.setWorkflowEnabled('nightly.check', false);
    expect(controller.getState().activity).toBe('Workflow disabled.');
  });

  it('replaces the list from the write’s own answer', async () => {
    const controller = new WorkflowController({
      client: fakeClient({
        create: () => Promise.resolve(ok([workflow(), workflow({ id: 'b' })])),
      }),
    });
    await controller.initialize();
    await controller.createWorkflow(INPUT);
    expect(controller.getState().workflows).toHaveLength(2);
  });
});

describe('running', () => {
  it('records the run and describes how it ended', async () => {
    const controller = new WorkflowController({
      client: fakeClient(),
      newRunId: () => RUN_ID,
    });
    await controller.initialize();
    await controller.startRun('nightly.check', 'look at the tree');

    expect(controller.getState().run?.status).toBe('completed');
    expect(controller.getState().activity).toContain('completed after 0 step(s)');
    expect(controller.getState().runningRunId).toBeNull();
  });

  it('mentions the rollback outcome when one was configured', async () => {
    const controller = new WorkflowController({
      client: fakeClient({
        run: () =>
          Promise.resolve(
            ok(
              run({
                status: 'failed',
                stopReason: 'step-failed',
                rollback: {
                  mode: 'restore-run-changes',
                  result: 'nothing-to-roll-back',
                  restored: 0,
                },
              }),
            ),
          ),
      }),
      newRunId: () => RUN_ID,
    });
    await controller.initialize();
    await controller.startRun('nightly.check', 'look at the tree');
    expect(controller.getState().activity).toContain('rollback nothing-to-roll-back');
  });

  it('holds the run id while a run is in flight, so pause and cancel have an address', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });

    const controller = new WorkflowController({
      client: fakeClient({ run: () => pending.then(() => ok(run())) }),
      newRunId: () => RUN_ID,
    });
    await controller.initialize();

    const started = controller.startRun('nightly.check', 'look at the tree');
    expect(controller.getState().runningRunId).toBe(RUN_ID);

    release();
    await started;
    expect(controller.getState().runningRunId).toBeNull();
  });

  it('ignores a second run while one is in flight', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runFn = vi.fn(() => pending.then(() => ok(run())));

    const controller = new WorkflowController({
      client: fakeClient({ run: runFn }),
      newRunId: () => RUN_ID,
    });
    await controller.initialize();

    const first = controller.startRun('nightly.check', 'one');
    await controller.startRun('nightly.check', 'two');
    release();
    await first;

    expect(runFn).toHaveBeenCalledTimes(1);
  });
});

describe('progress is advisory', () => {
  it('moves the step counter for the run in flight', async () => {
    const harness = progressHarness();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });

    const controller = new WorkflowController({
      client: { ...harness.client, run: () => pending.then(() => ok(run())) },
      newRunId: () => RUN_ID,
    });
    await controller.initialize();

    const started = controller.startRun('nightly.check', 'look');
    harness.emit(progressEvent({ completedSteps: 1, stepIndex: 1 }));

    expect(controller.getState().progress?.completedSteps).toBe(1);
    expect(controller.getState().progress?.stepIndex).toBe(1);

    release();
    await started;
  });

  it('surfaces the awaiting-confirmation state', async () => {
    const harness = progressHarness();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });

    const controller = new WorkflowController({
      client: { ...harness.client, run: () => pending.then(() => ok(run())) },
      newRunId: () => RUN_ID,
    });
    await controller.initialize();

    const started = controller.startRun('nightly.check', 'look');
    harness.emit(progressEvent({ phase: 'awaiting-confirmation' }));
    expect(controller.getState().progress?.awaitingConfirmation).toBe(true);

    harness.emit(progressEvent({ phase: 'step-finished', outcome: 'success' }));
    expect(controller.getState().progress?.awaitingConfirmation).toBe(false);

    release();
    await started;
  });

  it('ignores an event for a run it did not start', async () => {
    const harness = progressHarness();
    const controller = new WorkflowController({ client: harness.client });
    await controller.initialize();

    harness.emit(progressEvent({ runId: '22222222-2222-4222-8222-222222222222' }));
    expect(controller.getState().progress).toBeNull();
  });

  it('never lets an event change the run record', async () => {
    const harness = progressHarness();
    const controller = new WorkflowController({
      client: { ...harness.client, run: () => Promise.resolve(ok(run())) },
      newRunId: () => RUN_ID,
    });
    await controller.initialize();
    await controller.startRun('nightly.check', 'look');

    harness.emit(progressEvent({ phase: 'step-finished', outcome: 'denied' }));
    expect(controller.getState().run?.status).toBe('completed');
  });

  it('clears progress once the run answers', async () => {
    const harness = progressHarness();
    const controller = new WorkflowController({
      client: { ...harness.client, run: () => Promise.resolve(ok(run())) },
      newRunId: () => RUN_ID,
    });
    await controller.initialize();
    await controller.startRun('nightly.check', 'look');
    expect(controller.getState().progress).toBeNull();
  });
});

describe('pause and cancel', () => {
  it('does nothing when no run is in flight', async () => {
    const pause = vi.fn(() => Promise.resolve());
    const cancel = vi.fn(() => Promise.resolve());
    const controller = new WorkflowController({ client: fakeClient({ pause, cancel }) });
    await controller.initialize();

    await controller.pauseRun();
    await controller.cancelRun();
    expect(pause).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('asks by run id, and never claims the run has already stopped', async () => {
    const pause = vi.fn(() => Promise.resolve());
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });

    const controller = new WorkflowController({
      client: fakeClient({ pause, run: () => pending.then(() => ok(run())) }),
      newRunId: () => RUN_ID,
    });
    await controller.initialize();

    const started = controller.startRun('nightly.check', 'look');
    await controller.pauseRun();

    expect(pause).toHaveBeenCalledWith(RUN_ID);
    expect(controller.getState().activity).toContain('after the current step');
    expect(controller.getState().run).toBeNull();

    release();
    await started;
  });
});

describe('failures are shown in this file’s own words', () => {
  it('never displays a code', async () => {
    const controller = new WorkflowController({
      client: fakeClient({ create: () => Promise.resolve(fails('WORKFLOW_INVALID')) }),
    });
    await controller.initialize();
    await controller.createWorkflow(INPUT);
    expect(controller.getState().error?.message).not.toContain('WORKFLOW_');
  });

  it('explains the authority chain when a step is outside the agent', async () => {
    const controller = new WorkflowController({
      client: fakeClient({ create: () => Promise.resolve(fails('WORKFLOW_TOOL_NOT_ALLOWED')) }),
    });
    await controller.initialize();
    await controller.createWorkflow(INPUT);
    expect(controller.getState().error?.message).toContain('only narrow');
    expect(controller.getState().error?.retryable).toBe(false);
  });

  it('offers retry only where retrying could help', async () => {
    const retryable = new WorkflowController({
      client: fakeClient({ create: () => Promise.resolve(fails('WORKFLOW_STORE_FAILED')) }),
    });
    await retryable.initialize();
    await retryable.createWorkflow(INPUT);
    expect(retryable.getState().error?.retryable).toBe(true);

    const permanent = new WorkflowController({
      client: fakeClient({ create: () => Promise.resolve(fails('WORKFLOW_EXISTS')) }),
    });
    await permanent.initialize();
    await permanent.createWorkflow(INPUT);
    expect(permanent.getState().error?.retryable).toBe(false);
  });

  it('treats a denial as an error and a decline as an activity note', async () => {
    const denied = new WorkflowController({
      client: fakeClient({
        create: () => Promise.resolve({ ok: false, failure: { kind: 'denied' } }),
      }),
    });
    await denied.initialize();
    await denied.createWorkflow(INPUT);
    expect(denied.getState().error).not.toBeNull();

    const declined = new WorkflowController({
      client: fakeClient({
        create: () => Promise.resolve({ ok: false, failure: { kind: 'declined' } }),
      }),
    });
    await declined.initialize();
    await declined.createWorkflow(INPUT);
    expect(declined.getState().error).toBeNull();
    expect(declined.getState().activity).toContain('declined');
  });

  it('retries the operation that failed', async () => {
    const create = vi
      .fn<WorkflowClient['create']>()
      .mockResolvedValueOnce(fails('WORKFLOW_STORE_FAILED'))
      .mockResolvedValueOnce(ok([workflow()]));
    const controller = new WorkflowController({ client: fakeClient({ create }) });
    await controller.initialize();
    await controller.createWorkflow(INPUT);
    await controller.retry();
    expect(create).toHaveBeenCalledTimes(2);
    expect(controller.getState().error).toBeNull();
  });

  it('dismisses an error on request', async () => {
    const controller = new WorkflowController({
      client: fakeClient({ create: () => Promise.resolve(fails('WORKFLOW_STORE_FAILED')) }),
    });
    await controller.initialize();
    await controller.createWorkflow(INPUT);
    controller.dismissError();
    expect(controller.getState().error).toBeNull();
  });
});

describe('concurrency and lifetime', () => {
  it('discards a response that is no longer current', async () => {
    let release!: (value: WorkflowResult<readonly Workflow[]>) => void;
    const stale = new Promise<WorkflowResult<readonly Workflow[]>>((resolve) => {
      release = resolve;
    });

    const controller = new WorkflowController({ client: fakeClient({ list: () => stale }) });
    const pendingInit = controller.initialize();
    controller.dispose();
    release(ok([workflow()]));
    await pendingInit;

    expect(controller.getState().workflows).toEqual([]);
  });

  it('stops notifying listeners once disposed', async () => {
    const listener = vi.fn();
    const controller = new WorkflowController({ client: fakeClient() });
    controller.subscribe(listener);
    controller.dispose();
    await controller.initialize();
    expect(listener).not.toHaveBeenCalled();
  });

  it('stops notifying an unsubscribed listener', async () => {
    const listener = vi.fn();
    const controller = new WorkflowController({ client: fakeClient() });
    const unsubscribe = controller.subscribe(listener);
    unsubscribe();
    await controller.initialize();
    expect(listener).not.toHaveBeenCalled();
  });
});
