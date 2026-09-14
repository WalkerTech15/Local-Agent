import { describe, expect, it, vi } from 'vitest';

import { AgentController } from '../../../src/renderer/agent/agent-controller';
import type {
  AgentClient,
  AgentRegistryView,
  AgentResult,
} from '../../../src/renderer/agent/ipc-agent-client';
import { createBuiltInAgentProfiles, DEFAULT_AGENT_PROFILE_ID } from '../../../src/shared/agent';
import type { AgentProfileInput, AgentRun } from '../../../src/shared/schemas';

/**
 * The agent surface's state machine (Phase 2, Milestone 7).
 *
 * Driven directly, without React or jsdom, for the reason
 * `workspace-controller.test.ts` gives: neither is part of this project's
 * toolchain, so the behaviour worth testing lives in a plain class.
 *
 * The cases that matter most are the ones about *wording*: no message from
 * the main process may reach the screen, and a refusal the user made must not
 * be reported as an error.
 */

const RUN_ID = '0f3f2f6e-6bd3-4f37-9a3a-7f0f2e6ac111';

function registry(activeProfileId = DEFAULT_AGENT_PROFILE_ID): AgentRegistryView {
  return { activeProfileId, profiles: createBuiltInAgentProfiles() };
}

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    runId: RUN_ID,
    profileId: DEFAULT_AGENT_PROFILE_ID,
    profileName: 'Reviewer',
    provider: 'none',
    status: 'completed',
    stopReason: 'completed',
    startedAt: '2026-09-14T00:00:00.000Z',
    finishedAt: '2026-09-14T00:00:01.000Z',
    steps: [],
    verification: { required: [], satisfied: [], passed: true },
    totals: { steps: 0, outputBytes: 0, durationMs: 1000 },
    ...overrides,
  };
}

function profileInput(): AgentProfileInput {
  return {
    id: 'inspector',
    name: 'Inspector',
    description: '',
    instructions: '',
    provider: 'none',
    fallbackProviders: [],
    allowedTools: ['workspace.inspect'],
    approvedWorkspacePaths: ['src'],
    permissionPolicy: [],
    verification: [],
    limits: { maxSteps: 4, maxDurationMs: 30_000, maxOutputBytes: 10_000 },
    enabled: true,
  };
}

function ok<TValue>(value: TValue): AgentResult<TValue> {
  return { ok: true, value };
}

function createClient(overrides: Partial<AgentClient> = {}): AgentClient {
  return {
    list: () => Promise.resolve(ok(registry())),
    select: (profileId) => Promise.resolve(ok(registry(profileId))),
    create: () => Promise.resolve(ok(registry())),
    update: () => Promise.resolve(ok(registry())),
    remove: () => Promise.resolve(ok(registry())),
    setEnabled: () => Promise.resolve(ok(registry())),
    run: () => Promise.resolve(ok(run())),
    cancel: () => Promise.resolve(),
    ...overrides,
  };
}

function controller(overrides: Partial<AgentClient> = {}): AgentController {
  return new AgentController({ client: createClient(overrides), newRunId: () => RUN_ID });
}

describe('loading the registry', () => {
  it('starts empty and uninitialised', () => {
    const state = controller().getState();
    expect(state.profiles).toEqual([]);
    expect(state.activeProfileId).toBeNull();
    expect(state.initialized).toBe(false);
  });

  it('loads profiles and the active id', async () => {
    const agent = controller();
    await agent.initialize();

    const state = agent.getState();
    expect(state.initialized).toBe(true);
    expect(state.activeProfileId).toBe(DEFAULT_AGENT_PROFILE_ID);
    expect(state.profiles.length).toBeGreaterThan(0);
    expect(state.busy).toBeNull();
  });

  it('initialises only once', async () => {
    const list = vi.fn(() => Promise.resolve(ok(registry())));
    const agent = new AgentController({ client: createClient({ list }) });
    await agent.initialize();
    await agent.initialize();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('marks itself initialised even when the first load fails', async () => {
    const agent = controller({
      list: () =>
        Promise.resolve({ ok: false, failure: { kind: 'error', code: 'AGENT_RUN_FAILED' } }),
    });
    await agent.initialize();
    expect(agent.getState().initialized).toBe(true);
    expect(agent.getState().error).not.toBeNull();
  });
});

describe('what a user is shown when something goes wrong', () => {
  it('never displays a message that came from the main process', async () => {
    const agent = controller({
      select: () =>
        Promise.resolve({
          ok: false,
          failure: { kind: 'error', code: 'AGENT_PROFILE_READ_ONLY' },
        }),
    });
    await agent.selectProfile('reviewer');

    const message = agent.getState().error?.message ?? '';
    expect(message).toContain('Built-in profiles');
    // The code itself is an internal token and must not be what a person reads.
    expect(message).not.toContain('AGENT_PROFILE_READ_ONLY');
  });

  it('has a reviewed sentence for every code the client can produce', async () => {
    const codes = [
      'AGENT_PROFILE_NOT_FOUND',
      'AGENT_PROFILE_EXISTS',
      'AGENT_PROFILE_READ_ONLY',
      'AGENT_PROFILE_DISABLED',
      'AGENT_PROFILE_LIMIT_REACHED',
      'AGENT_PROFILE_INVALID',
      'AGENT_PROFILE_STORE_FAILED',
      'AGENT_TOOL_NOT_ALLOWED',
      'AGENT_WORKSPACE_NOT_ALLOWED',
      'AGENT_PROVIDER_UNAVAILABLE',
      'AGENT_RUN_ALREADY_RUNNING',
      'AGENT_NO_PROJECT',
      'AGENT_LIMIT_REACHED',
      'AGENT_RUN_CANCELLED',
      'AGENT_EMERGENCY_STOPPED',
      'AGENT_VERIFICATION_FAILED',
      'AGENT_RUN_FAILED',
    ] as const;

    for (const code of codes) {
      const agent = controller({
        list: () => Promise.resolve({ ok: false, failure: { kind: 'error', code } }),
      });
      await agent.refresh();
      const message = agent.getState().error?.message ?? '';
      expect(message.length, code).toBeGreaterThan(0);
      expect(message, code).not.toContain(code);
    }
  });

  it('reports a denial as a refusal rather than a malfunction', async () => {
    const agent = controller({
      list: () => Promise.resolve({ ok: false, failure: { kind: 'denied' } }),
    });
    await agent.refresh();
    expect(agent.getState().error?.message).toContain('refused');
    expect(agent.getState().error?.retryable).toBe(false);
  });

  it('treats a declined confirmation as an activity note, never an error', async () => {
    const agent = controller({
      create: () => Promise.resolve({ ok: false, failure: { kind: 'declined' } }),
    });
    await agent.createProfile(profileInput());

    expect(agent.getState().error).toBeNull();
    expect(agent.getState().activity).toContain('declined');
  });

  it('offers Retry only where a second attempt could plausibly differ', async () => {
    const retryable = controller({
      list: () =>
        Promise.resolve({
          ok: false,
          failure: { kind: 'error', code: 'AGENT_PROFILE_STORE_FAILED' },
        }),
    });
    await retryable.refresh();
    expect(retryable.getState().error?.retryable).toBe(true);

    const permanent = controller({
      list: () =>
        Promise.resolve({ ok: false, failure: { kind: 'error', code: 'AGENT_PROFILE_READ_ONLY' } }),
    });
    await permanent.refresh();
    expect(permanent.getState().error?.retryable).toBe(false);
  });

  it('dismisses an error without repeating the request', () => {
    const agent = controller();
    agent.dismissError();
    expect(agent.getState().error).toBeNull();
  });
});

describe('profile operations', () => {
  it('sends only the validated profile it was given', async () => {
    const create = vi.fn(() => Promise.resolve(ok(registry())));
    const agent = new AgentController({ client: createClient({ create }) });
    const profile = profileInput();
    await agent.createProfile(profile);
    expect(create).toHaveBeenCalledWith(profile);
  });

  it('refuses to start a second operation while one is in flight', async () => {
    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const select = vi.fn(async () => {
      await parked;
      return ok(registry('inspector'));
    });

    const agent = new AgentController({ client: createClient({ select }) });
    const first = agent.selectProfile('inspector');
    await agent.selectProfile('reviewer');

    expect(select).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it('applies the newest response and discards a stale one', async () => {
    // A second request supersedes the first; the first's late answer must not
    // be written over the newer state.
    const agent = controller();
    await agent.refresh();

    const stale = agent.getState();
    expect(stale.activeProfileId).toBe(DEFAULT_AGENT_PROFILE_ID);

    await agent.selectProfile('verifier');
    expect(agent.getState().activeProfileId).toBe('verifier');
  });

  it('notifies subscribers and stops after unsubscribe', async () => {
    const agent = controller();
    const listener = vi.fn();
    const unsubscribe = agent.subscribe(listener);

    await agent.refresh();
    expect(listener).toHaveBeenCalled();

    unsubscribe();
    listener.mockClear();
    await agent.refresh();
    expect(listener).not.toHaveBeenCalled();
  });

  it('applies nothing once disposed', async () => {
    const agent = controller();
    agent.dispose();
    await agent.refresh();
    expect(agent.getState().initialized).toBe(false);
  });
});

describe('runs', () => {
  it('sends the objective and nothing else', async () => {
    const runFn = vi.fn(() => Promise.resolve(ok(run())));
    const agent = new AgentController({
      client: createClient({ run: runFn }),
      newRunId: () => RUN_ID,
    });

    await agent.startRun('look at the loader');
    expect(runFn).toHaveBeenCalledWith(RUN_ID, 'look at the loader');
  });

  it('keeps the run record and summarises how it ended', async () => {
    const agent = controller({
      run: () =>
        Promise.resolve(
          ok(
            run({
              status: 'failed',
              stopReason: 'step-failed',
              totals: { steps: 3, outputBytes: 120, durationMs: 500 },
              verification: { required: ['plan-produced'], satisfied: [], passed: false },
            }),
          ),
        ),
    });

    await agent.startRun('look at the loader');
    const state = agent.getState();
    expect(state.run?.status).toBe('failed');
    expect(state.activity).toContain('step-failed');
    expect(state.activity).toContain('verification failed');
    expect(state.runningRunId).toBeNull();
  });

  it('clears the previous run before starting a new one', async () => {
    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = new AgentController({
      client: createClient({
        run: async () => {
          await parked;
          return ok(run());
        },
      }),
      newRunId: () => RUN_ID,
    });

    const pending = agent.startRun('look at the loader');
    expect(agent.getState().run).toBeNull();
    expect(agent.getState().runningRunId).toBe(RUN_ID);

    release();
    await pending;
  });

  it('cancels the run in flight by its own id', async () => {
    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancel = vi.fn(() => Promise.resolve());
    const agent = new AgentController({
      client: createClient({
        run: async () => {
          await parked;
          return ok(run({ status: 'stopped', stopReason: 'cancelled' }));
        },
        cancel,
      }),
      newRunId: () => RUN_ID,
    });

    const pending = agent.startRun('look at the loader');
    await agent.cancelRun();
    expect(cancel).toHaveBeenCalledWith(RUN_ID);

    release();
    await pending;
    expect(agent.getState().run?.stopReason).toBe('cancelled');
  });

  it('does nothing when asked to cancel with no run in flight', async () => {
    const cancel = vi.fn(() => Promise.resolve());
    const agent = new AgentController({ client: createClient({ cancel }) });
    await agent.cancelRun();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('repeats the last operation on retry', async () => {
    const runFn = vi
      .fn<() => Promise<AgentResult<AgentRun>>>()
      .mockResolvedValueOnce({ ok: false, failure: { kind: 'error', code: 'AGENT_RUN_FAILED' } })
      .mockResolvedValueOnce(ok(run()));

    const agent = new AgentController({
      client: createClient({ run: runFn }),
      newRunId: () => RUN_ID,
    });

    await agent.startRun('look at the loader');
    expect(agent.getState().error).not.toBeNull();

    await agent.retry();
    expect(runFn).toHaveBeenCalledTimes(2);
    expect(agent.getState().error).toBeNull();
    expect(agent.getState().run).not.toBeNull();
  });
});
