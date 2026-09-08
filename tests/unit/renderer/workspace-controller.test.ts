import { describe, expect, it, vi } from 'vitest';

import type {
  WorkspaceClient,
  WorkspaceResult,
} from '../../../src/renderer/workspace/ipc-workspace-client';
import {
  WorkspaceController,
  type WorkspaceState,
} from '../../../src/renderer/workspace/workspace-controller';
import type {
  CodingPlan,
  WorkspaceFile,
  WorkspaceProjectSummary,
  WorkspaceSearchResult,
  WorkspaceTree,
} from '../../../src/shared/schemas';
import type { WorkspaceErrorCode } from '../../../src/shared/workspace';

/**
 * Workspace interface behaviour (Phase 2, Milestone 5).
 *
 * Everything the interface actually does — loading, empty, error, retry,
 * staleness, the approval gate — lives in `WorkspaceController`, so it is
 * tested here with plain Vitest and a fake client. React Testing Library and
 * jsdom are not part of this project's toolchain
 * (`docs/security-model.md`, known limitation 18), which is exactly why the
 * component holds no logic of its own.
 */

const PROJECT: WorkspaceProjectSummary = {
  name: 'demo',
  path: 'C:\\Users\\me\\demo',
  selectedAt: '2026-09-07T00:00:00.000Z',
  markers: ['package.json'],
  hasGitMetadata: true,
};

const TREE: WorkspaceTree = {
  root: '',
  entries: [
    { path: 'src', name: 'src', kind: 'directory', depth: 0, excluded: false, readable: false },
    {
      path: 'src/index.ts',
      name: 'index.ts',
      kind: 'file',
      depth: 1,
      size: 24,
      excluded: false,
      readable: true,
    },
  ],
  truncated: false,
};

const FILE: WorkspaceFile = {
  metadata: {
    path: 'src/index.ts',
    name: 'index.ts',
    size: 24,
    lineCount: 1,
    encoding: 'utf-8',
    warnings: [],
  },
  content: 'export const answer = 42;',
};

const SEARCH: WorkspaceSearchResult = {
  query: 'answer',
  matches: [{ path: 'src/index.ts', line: 1, column: 14, excerpt: 'export const answer = 42;' }],
  filesScanned: 3,
  truncated: false,
};

const PLAN: CodingPlan = {
  objective: { request: 'Add retry', summary: 'A request about retry.', keywords: ['retry'] },
  context: {
    projectName: 'demo',
    markers: ['package.json'],
    hasGitMetadata: true,
    hasTestTooling: true,
    filesInspected: 3,
    searchTruncated: false,
  },
  steps: [{ order: 1, title: 'Read', detail: 'Read the files first.' }],
  relevantFiles: [{ path: 'src/index.ts', reason: 'Matched 1 term.' }],
  risks: ['Read-only inspection.'],
  assumptions: ['The project is the right one.'],
  expectedChanges: [{ path: 'src/index.ts', changeType: 'review', rationale: 'Read it first.' }],
  changeSummary: '1 file identified. Nothing has been applied.',
  diff: null,
  approvalRequired: true,
  status: 'awaiting-approval',
  generatedAt: '2026-09-07T00:00:00.000Z',
};

function ok<T>(value: T): WorkspaceResult<T> {
  return { ok: true, value };
}

function errored<T>(code: WorkspaceErrorCode): WorkspaceResult<T> {
  return { ok: false, failure: { kind: 'error', code } };
}

function denied<T>(): WorkspaceResult<T> {
  return { ok: false, failure: { kind: 'denied' } };
}

/** A client whose every method resolves successfully unless overridden. */
function fakeClient(overrides: Partial<WorkspaceClient> = {}): WorkspaceClient {
  return {
    status: () => Promise.resolve(ok<WorkspaceProjectSummary | null>(null)),
    select: () => Promise.resolve(ok<WorkspaceProjectSummary | null>(PROJECT)),
    tree: () => Promise.resolve(ok(TREE)),
    file: () => Promise.resolve(ok(FILE)),
    search: () => Promise.resolve(ok(SEARCH)),
    plan: () => Promise.resolve(ok(PLAN)),
    ...overrides,
  };
}

function controllerWith(overrides: Partial<WorkspaceClient> = {}): WorkspaceController {
  return new WorkspaceController({ client: fakeClient(overrides) });
}

/** Every state the controller published, in order. */
function record(controller: WorkspaceController): WorkspaceState[] {
  const states: WorkspaceState[] = [];
  controller.subscribe((state) => states.push(state));
  return states;
}

/**
 * A promise whose resolution the test controls.
 *
 * Deliberately a property on an object rather than a `let` assigned inside
 * the executor: TypeScript narrows such a variable to its initial `null` and
 * then reports every later call on it as unreachable, which is the same
 * closure-narrowing trap that cost this codebase a real defect in Milestone
 * 4. A property assignment is not narrowed that way.
 */
function deferred<T>(): { readonly promise: Promise<T>; resolve: (value: T) => void } {
  const holder: { promise: Promise<T>; resolve: (value: T) => void } = {
    promise: Promise.resolve(undefined as T),
    resolve: () => undefined,
  };
  holder.promise = new Promise<T>((resolve) => {
    holder.resolve = resolve;
  });
  return holder;
}

describe('initial and empty states', () => {
  it('starts empty, idle and uninitialised', () => {
    const state = controllerWith().getState();
    expect(state).toEqual({
      project: null,
      initialized: false,
      busy: null,
      tree: null,
      openFile: null,
      search: null,
      plan: null,
      planApproved: false,
      activity: null,
      error: null,
    });
  });

  it('marks itself initialised with no project when none was approved', async () => {
    const controller = controllerWith();
    await controller.initialize();
    expect(controller.getState().initialized).toBe(true);
    expect(controller.getState().project).toBeNull();
    expect(controller.getState().error).toBeNull();
  });

  it('adopts a project already approved earlier in the session, and lists it', async () => {
    const controller = controllerWith({
      status: () => Promise.resolve(ok<WorkspaceProjectSummary | null>(PROJECT)),
    });
    await controller.initialize();
    expect(controller.getState().project).toEqual(PROJECT);
    expect(controller.getState().tree).toEqual(TREE);
  });
});

describe('loading state', () => {
  it('reports which operation is in flight, and returns to idle after it', async () => {
    const pendingFile = deferred<WorkspaceResult<WorkspaceFile>>();
    const controller = controllerWith({
      status: () => Promise.resolve(ok<WorkspaceProjectSummary | null>(PROJECT)),
      file: () => pendingFile.promise,
    });
    await controller.initialize();

    const pending = controller.openFile('src/index.ts');
    expect(controller.getState().busy).toBe('file');
    expect(controller.canAct).toBe(false);

    pendingFile.resolve(ok(FILE));
    await pending;
    expect(controller.getState().busy).toBeNull();
    expect(controller.canAct).toBe(true);
  });

  it('clears a standing error the moment a new request starts', async () => {
    const controller = controllerWith({
      tree: () => Promise.resolve(errored('WORKSPACE_READ_FAILED')),
    });
    await controller.refreshTree('');
    expect(controller.getState().error).not.toBeNull();

    const states = record(controller);
    await controller.openFile('src/index.ts');
    expect(states[0]?.error).toBeNull();
  });
});

describe('project selection', () => {
  it('records the approved project and lists it', async () => {
    const controller = controllerWith();
    const states = record(controller);

    await controller.selectProject();
    expect(controller.getState().project).toEqual(PROJECT);
    // Selecting immediately lists the root, so the *last* activity describes
    // the listing; the project name appears in the state published between
    // the two.
    expect(controller.getState().tree).toEqual(TREE);
    expect(states.some((state) => state.activity?.includes('demo') === true)).toBe(true);
    expect(controller.getState().activity).toContain('Listed');
  });

  it('sends no path: the caller cannot name the directory', async () => {
    const select = vi.fn(() => Promise.resolve(ok<WorkspaceProjectSummary | null>(PROJECT)));
    const controller = controllerWith({ select });
    await controller.selectProject();
    expect(select).toHaveBeenCalledWith();
    expect(select.mock.calls[0]).toEqual([]);
  });

  it('discards everything about the previous project when a new one is chosen', async () => {
    const controller = controllerWith({
      status: () => Promise.resolve(ok<WorkspaceProjectSummary | null>(PROJECT)),
    });
    await controller.initialize();
    await controller.openFile('src/index.ts');
    await controller.search('answer');
    await controller.createPlan('Add retry');
    controller.approvePlan();
    expect(controller.getState().planApproved).toBe(true);

    await controller.selectProject();
    const state = controller.getState();
    expect(state.openFile).toBeNull();
    expect(state.search).toBeNull();
    expect(state.plan).toBeNull();
    // Approval never carries over to a project the user has not planned for.
    expect(state.planApproved).toBe(false);
  });

  it('treats a cancelled picker as a no-op, never as an error', async () => {
    const controller = controllerWith({
      select: () =>
        Promise.resolve(errored<WorkspaceProjectSummary | null>('WORKSPACE_SELECTION_CANCELLED')),
    });
    await controller.selectProject();
    const state = controller.getState();
    expect(state.error).toBeNull();
    expect(state.project).toBeNull();
    expect(state.busy).toBeNull();
    expect(state.activity).toContain('cancelled');
  });
});

describe('error state', () => {
  it('shows a message owned by this codebase, never one from the main process', async () => {
    const controller = controllerWith({
      file: () => Promise.resolve(errored('WORKSPACE_BINARY_FILE')),
    });
    await controller.openFile('assets/logo.png');
    expect(controller.getState().error?.message).toBe('That file is not text, so it is not shown.');
  });

  it('has a distinct message for every normalized code', async () => {
    const codes: WorkspaceErrorCode[] = [
      'WORKSPACE_NO_PROJECT',
      'WORKSPACE_INVALID_PROJECT',
      'WORKSPACE_INVALID_PATH',
      'WORKSPACE_PATH_OUTSIDE_PROJECT',
      'WORKSPACE_PATH_EXCLUDED',
      'WORKSPACE_NOT_FOUND',
      'WORKSPACE_ACCESS_DENIED',
      'WORKSPACE_UNSUPPORTED_ENTRY',
      'WORKSPACE_FILE_TOO_LARGE',
      'WORKSPACE_BINARY_FILE',
      'WORKSPACE_READ_FAILED',
    ];
    const messages = new Set<string>();
    for (const code of codes) {
      const controller = controllerWith({ file: () => Promise.resolve(errored(code)) });
      await controller.openFile('src/index.ts');
      const message = controller.getState().error?.message;
      expect(message, code).toBeDefined();
      messages.add(message ?? '');
    }
    expect(messages.size).toBe(codes.length);
  });

  it('explains a denial in terms of the permission engine and the emergency stop', async () => {
    const controller = controllerWith({ tree: () => Promise.resolve(denied()) });
    await controller.refreshTree('');
    expect(controller.getState().error?.message).toContain('emergency stop');
    expect(controller.getState().error?.retryable).toBe(true);
  });

  it('offers Retry only where retrying could plausibly help', async () => {
    const retryable = controllerWith({
      file: () => Promise.resolve(errored('WORKSPACE_ACCESS_DENIED')),
    });
    await retryable.openFile('src/index.ts');
    expect(retryable.getState().error?.retryable).toBe(true);

    // An excluded path or an oversized file will answer the same next time.
    const notRetryable = controllerWith({
      file: () => Promise.resolve(errored('WORKSPACE_PATH_EXCLUDED')),
    });
    await notRetryable.openFile('.env');
    expect(notRetryable.getState().error?.retryable).toBe(false);
  });

  it('keeps whatever was already on screen when a request fails', async () => {
    let shouldFail = false;
    const controller = controllerWith({
      status: () => Promise.resolve(ok<WorkspaceProjectSummary | null>(PROJECT)),
      file: () =>
        shouldFail
          ? Promise.resolve(errored<WorkspaceFile>('WORKSPACE_READ_FAILED'))
          : Promise.resolve(ok(FILE)),
    });
    await controller.initialize();
    await controller.openFile('src/index.ts');
    expect(controller.getState().openFile).toEqual(FILE);

    shouldFail = true;
    await controller.openFile('src/other.ts');
    expect(controller.getState().openFile).toEqual(FILE);
    expect(controller.getState().error).not.toBeNull();
  });

  it('can dismiss an error without re-running anything', async () => {
    const file = vi.fn(() => Promise.resolve(errored<WorkspaceFile>('WORKSPACE_READ_FAILED')));
    const controller = controllerWith({ file });
    await controller.openFile('src/index.ts');
    controller.dismissError();
    expect(controller.getState().error).toBeNull();
    expect(file).toHaveBeenCalledTimes(1);
  });
});

describe('retry', () => {
  it('re-runs the request that failed, with the same arguments', async () => {
    const attempts: string[] = [];
    let shouldFail = true;
    const controller = controllerWith({
      file: (path: string) => {
        attempts.push(path);
        if (shouldFail) {
          shouldFail = false;
          return Promise.resolve(errored<WorkspaceFile>('WORKSPACE_READ_FAILED'));
        }
        return Promise.resolve(ok(FILE));
      },
    });

    await controller.openFile('src/index.ts');
    expect(controller.getState().error).not.toBeNull();

    await controller.retry();
    expect(attempts).toEqual(['src/index.ts', 'src/index.ts']);
    expect(controller.getState().openFile).toEqual(FILE);
    expect(controller.getState().error).toBeNull();
  });

  it('re-runs a failed search with the same query', async () => {
    const queries: string[] = [];
    let shouldFail = true;
    const controller = controllerWith({
      search: (query: string) => {
        queries.push(query);
        if (shouldFail) {
          shouldFail = false;
          return Promise.resolve(errored<WorkspaceSearchResult>('WORKSPACE_READ_FAILED'));
        }
        return Promise.resolve(ok(SEARCH));
      },
    });

    await controller.search('answer');
    await controller.retry();
    expect(queries).toEqual(['answer', 'answer']);
    expect(controller.getState().search).toEqual(SEARCH);
  });

  it('is a no-op with no standing error', async () => {
    const file = vi.fn(() => Promise.resolve(ok(FILE)));
    const controller = controllerWith({ file });
    await controller.openFile('src/index.ts');
    await controller.retry();
    expect(file).toHaveBeenCalledTimes(1);
  });
});

describe('staleness', () => {
  it('discards a response that a newer request has already superseded', async () => {
    const resolvers: ((result: WorkspaceResult<WorkspaceFile>) => void)[] = [];
    const controller = controllerWith({
      file: () =>
        new Promise<WorkspaceResult<WorkspaceFile>>((resolve) => {
          resolvers.push(resolve);
        }),
    });

    const first = controller.openFile('src/first.ts');
    const second = controller.openFile('src/second.ts');

    const secondFile: WorkspaceFile = {
      ...FILE,
      metadata: { ...FILE.metadata, path: 'src/second.ts', name: 'second.ts' },
    };
    // The newer request answers first, then the older one arrives late.
    resolvers[1]?.(ok(secondFile));
    await second;
    resolvers[0]?.(ok(FILE));
    await first;

    expect(controller.getState().openFile?.metadata.path).toBe('src/second.ts');
  });

  it('stops publishing state after dispose, and discards late responses', async () => {
    const pendingFile = deferred<WorkspaceResult<WorkspaceFile>>();
    const controller = controllerWith({ file: () => pendingFile.promise });

    const states = record(controller);
    const pending = controller.openFile('src/index.ts');
    const countAtDispose = states.length;

    controller.dispose();
    pendingFile.resolve(ok(FILE));
    await pending;

    expect(states.length).toBe(countAtDispose);
    expect(controller.getState().openFile).toBeNull();
  });
});

describe('search and listing', () => {
  it('does not contact the client for a blank query', async () => {
    const search = vi.fn(() => Promise.resolve(ok(SEARCH)));
    const controller = controllerWith({ search });
    await controller.search('   ');
    expect(search).not.toHaveBeenCalled();
  });

  it('trims the query before sending it', async () => {
    const search = vi.fn(() => Promise.resolve(ok(SEARCH)));
    const controller = controllerWith({ search });
    await controller.search('  answer  ');
    expect(search).toHaveBeenCalledWith('answer', '');
  });

  it('reports the result count and truncation in the activity line', async () => {
    const controller = controllerWith({
      search: () => Promise.resolve(ok({ ...SEARCH, truncated: true })),
    });
    await controller.search('answer');
    expect(controller.getState().activity).toContain('1 match');
    expect(controller.getState().activity).toContain('truncated');
  });

  it('reports a truncated listing', async () => {
    const controller = controllerWith({
      tree: () => Promise.resolve(ok({ ...TREE, truncated: true })),
    });
    await controller.refreshTree('');
    expect(controller.getState().activity).toContain('truncated');
  });
});

describe('the plan approval gate', () => {
  it('produces a plan that is not approved until the user approves it', async () => {
    const controller = controllerWith();
    await controller.createPlan('Add retry');
    expect(controller.getState().plan).toEqual(PLAN);
    expect(controller.getState().planApproved).toBe(false);

    controller.approvePlan();
    expect(controller.getState().planApproved).toBe(true);
  });

  it('says plainly that approval unlocks no modification', async () => {
    const controller = controllerWith();
    await controller.createPlan('Add retry');
    controller.approvePlan();
    expect(controller.getState().activity).toContain('No modification capability');
  });

  it('cannot approve when there is no plan', () => {
    const controller = controllerWith();
    controller.approvePlan();
    expect(controller.getState().planApproved).toBe(false);
  });

  it('resets approval for every newly generated plan', async () => {
    const controller = controllerWith();
    await controller.createPlan('Add retry');
    controller.approvePlan();
    expect(controller.getState().planApproved).toBe(true);

    await controller.createPlan('Something else entirely');
    expect(controller.getState().planApproved).toBe(false);
  });

  it('does not contact the client for a blank objective', async () => {
    const plan = vi.fn(() => Promise.resolve(ok(PLAN)));
    const controller = controllerWith({ plan });
    await controller.createPlan('  ');
    expect(plan).not.toHaveBeenCalled();
  });

  it('exposes no method that could apply a plan', () => {
    const controller = controllerWith();
    const names = [
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(controller) as object),
      ...Object.keys(controller),
    ];
    for (const forbidden of [
      'apply',
      'applyPlan',
      'write',
      'writeFile',
      'modify',
      'execute',
      'run',
    ]) {
      expect(names, forbidden).not.toContain(forbidden);
    }
  });
});
