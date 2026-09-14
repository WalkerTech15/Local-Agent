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
  CommandCatalog,
  CommandRunResult,
  GitCheckpointValue,
  GitDiffValue,
  GitStatusValue,
  WorkspaceChangeHistory,
  WorkspaceChangeSet,
  WorkspaceFile,
  WorkspaceProjectSummary,
  WorkspaceSearchResult,
  WorkspaceTree,
} from '../../../src/shared/schemas';
import type { WorkspaceErrorCode } from '../../../src/shared/workspace';

/**
 * Workspace interface behaviour (Phase 2, Milestones 5-6).
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

/** The user answering "no" to a native confirmation (Phase 2, Milestone 6). */
function declined<T>(): WorkspaceResult<T> {
  return { ok: false, failure: { kind: 'declined' } };
}

const CHANGE: WorkspaceChangeSet = {
  id: '11111111-1111-4111-8111-111111111111',
  createdAt: '2026-09-07T00:00:00.000Z',
  status: 'awaiting-approval',
  files: [
    {
      path: 'src/index.ts',
      name: 'index.ts',
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: [
            { kind: 'removed', text: 'export const answer = 42;' },
            { kind: 'added', text: 'export const answer = 43;' },
          ],
        },
      ],
      added: 1,
      removed: 1,
      coarse: false,
      truncated: false,
      warnings: [],
    },
  ],
  totalAdded: 1,
  totalRemoved: 1,
  truncated: false,
  approvalRequired: true,
  backupAvailable: false,
  appliedAt: null,
  rolledBackAt: null,
};

const APPLIED: WorkspaceChangeSet = {
  ...CHANGE,
  status: 'applied',
  backupAvailable: true,
  appliedAt: '2026-09-07T00:01:00.000Z',
};

const HISTORY: WorkspaceChangeHistory = { changes: [APPLIED], rollbackTarget: APPLIED.id };

const CATALOG: CommandCatalog = {
  commands: [
    {
      id: 'test',
      label: 'Run tests',
      description: 'Runs the project’s own test script.',
      commandLine: 'npm run test',
      available: true,
      scriptPreview: 'vitest run',
      risks: [],
    },
  ],
  busy: false,
};

const RUN: CommandRunResult = {
  runId: '22222222-2222-4222-8222-222222222222',
  commandId: 'test',
  commandLine: 'npm run test',
  outcome: 'succeeded',
  exitCode: 0,
  startedAt: '2026-09-07T00:00:00.000Z',
  finishedAt: '2026-09-07T00:00:02.000Z',
  durationMs: 2000,
  output: [{ stream: 'stdout', text: 'ok' }],
  outputTruncated: false,
  timedOut: false,
  cancelled: false,
  stoppedByEmergency: false,
};

const GIT_STATUS: GitStatusValue = {
  branch: 'main',
  entries: [{ path: 'src/index.ts', code: ' M', state: 'modified', staged: false }],
  clean: false,
  truncated: false,
  unparsableEntries: 0,
};

const GIT_DIFF: GitDiffValue = {
  path: null,
  lines: [{ kind: 'meta', text: 'diff --git a/src/index.ts b/src/index.ts' }],
  truncated: false,
  empty: false,
};

const CHECKPOINT: GitCheckpointValue = {
  branch: 'main',
  commit: 'abc1234',
  message: 'Local Agent checkpoint 2026-09-07T00:00:00.000Z',
  filesChanged: 1,
  createdAt: '2026-09-07T00:00:00.000Z',
};

/** A client whose every method resolves successfully unless overridden. */
function fakeClient(overrides: Partial<WorkspaceClient> = {}): WorkspaceClient {
  return {
    status: () => Promise.resolve(ok<WorkspaceProjectSummary | null>(null)),
    select: () => Promise.resolve(ok<WorkspaceProjectSummary | null>(PROJECT)),
    tree: () => Promise.resolve(ok(TREE)),
    file: () => Promise.resolve(ok(FILE)),
    search: () => Promise.resolve(ok(SEARCH)),
    plan: () => Promise.resolve(ok(PLAN)),
    propose: () => Promise.resolve(ok(CHANGE)),
    apply: () => Promise.resolve(ok(APPLIED)),
    rollback: () => Promise.resolve(ok({ ...APPLIED, status: 'rolled-back' as const })),
    changes: () => Promise.resolve(ok(HISTORY)),
    commands: () => Promise.resolve(ok(CATALOG)),
    runCommand: () => Promise.resolve(ok(RUN)),
    cancelCommand: () => Promise.resolve(),
    gitStatus: () => Promise.resolve(ok(GIT_STATUS)),
    gitDiff: () => Promise.resolve(ok(GIT_DIFF)),
    gitCheckpoint: () => Promise.resolve(ok(CHECKPOINT)),
    ...overrides,
  };
}

function controllerWith(overrides: Partial<WorkspaceClient> = {}): WorkspaceController {
  return new WorkspaceController({
    client: fakeClient(overrides),
    newRunId: () => '22222222-2222-4222-8222-222222222222',
  });
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
      change: null,
      changeApproved: false,
      history: null,
      commands: null,
      commandRun: null,
      runningCommand: null,
      gitStatus: null,
      gitDiff: null,
      checkpoint: null,
      activity: null,
      error: null,
    });
  });

  it('starts with both approval gates closed', () => {
    // Asserted separately from the shape above so that a future field being
    // added cannot quietly carry an approval in with it.
    const state = controllerWith().getState();
    expect(state.planApproved).toBe(false);
    expect(state.changeApproved).toBe(false);
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

  it('says plainly that approving a plan is not approving a change', async () => {
    const controller = controllerWith();
    await controller.createPlan('Add retry');
    controller.approvePlan();
    expect(controller.getState().activity).toContain('separate, explicit step');
  });

  it('approving a plan produces no change and unlocks no write', async () => {
    // The gate that matters after Milestone 6: a plan and a change are
    // separate objects with separate approvals. Approving a plan must not
    // create a change set, must not approve one, and must leave `applyChange`
    // with nothing it is willing to do.
    const apply = vi.fn();
    const controller = controllerWith({ apply });
    await controller.createPlan('Add retry');
    controller.approvePlan();

    expect(controller.getState().planApproved).toBe(true);
    expect(controller.getState().change).toBeNull();
    expect(controller.getState().changeApproved).toBe(false);

    await controller.applyChange();
    expect(apply).not.toHaveBeenCalled();
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

describe('the change approval gate', () => {
  it('proposes a change without approving it', async () => {
    const controller = controllerWith();
    await controller.proposeChange([{ path: 'src/index.ts', content: 'x' }]);
    expect(controller.getState().change?.status).toBe('awaiting-approval');
    expect(controller.getState().changeApproved).toBe(false);
  });

  it('refuses to apply a change the user has not approved', async () => {
    const apply = vi.fn(() => Promise.resolve(ok(APPLIED)));
    const controller = controllerWith({ apply });
    await controller.proposeChange([{ path: 'src/index.ts', content: 'x' }]);

    await controller.applyChange();
    expect(apply).not.toHaveBeenCalled();
  });

  it('applies only after the diff has been approved', async () => {
    const apply = vi.fn(() => Promise.resolve(ok(APPLIED)));
    const controller = controllerWith({ apply });
    await controller.proposeChange([{ path: 'src/index.ts', content: 'x' }]);
    controller.approveChange();
    await controller.applyChange();

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(CHANGE.id);
    expect(controller.getState().change?.status).toBe('applied');
  });

  it('sends only the change id, never a path or content', async () => {
    const apply = vi.fn(() => Promise.resolve(ok(APPLIED)));
    const controller = controllerWith({ apply });
    await controller.proposeChange([{ path: 'src/index.ts', content: 'x' }]);
    controller.approveChange();
    await controller.applyChange();

    expect(apply.mock.calls[0]).toEqual([CHANGE.id]);
  });

  it('resets approval for every newly proposed change', async () => {
    const controller = controllerWith();
    await controller.proposeChange([{ path: 'src/index.ts', content: 'x' }]);
    controller.approveChange();
    expect(controller.getState().changeApproved).toBe(true);

    await controller.proposeChange([{ path: 'src/index.ts', content: 'y' }]);
    expect(controller.getState().changeApproved).toBe(false);
  });

  it('resets approval after applying, so it is never reused', async () => {
    const controller = controllerWith();
    await controller.proposeChange([{ path: 'src/index.ts', content: 'x' }]);
    controller.approveChange();
    await controller.applyChange();
    expect(controller.getState().changeApproved).toBe(false);
  });

  it('cannot approve when there is no change on screen', () => {
    const controller = controllerWith();
    controller.approveChange();
    expect(controller.getState().changeApproved).toBe(false);
  });

  it('cannot approve a change that has already been applied', async () => {
    const controller = controllerWith({ propose: () => Promise.resolve(ok(APPLIED)) });
    await controller.proposeChange([{ path: 'src/index.ts', content: 'x' }]);
    controller.approveChange();
    expect(controller.getState().changeApproved).toBe(false);
  });

  it('says plainly that approving here is not the system confirmation', async () => {
    const controller = controllerWith();
    await controller.proposeChange([{ path: 'src/index.ts', content: 'x' }]);
    controller.approveChange();
    expect(controller.getState().activity).toContain('system confirmation');
  });

  it('clears the open file after applying, because it is now out of date', async () => {
    const controller = controllerWith();
    await controller.openFile('src/index.ts');
    expect(controller.getState().openFile).not.toBeNull();

    await controller.proposeChange([{ path: 'src/index.ts', content: 'x' }]);
    controller.approveChange();
    await controller.applyChange();
    expect(controller.getState().openFile).toBeNull();
  });

  it('drops a failed proposal rather than leaving a stale diff on screen', async () => {
    const controller = controllerWith({
      propose: () => Promise.resolve(errored<WorkspaceChangeSet>('WORKSPACE_CHANGE_EMPTY')),
    });
    await controller.proposeChange([{ path: 'src/index.ts', content: 'x' }]);
    expect(controller.getState().change).toBeNull();
    expect(controller.getState().error?.message).toContain('exactly as it is');
  });
});

describe('declining a confirmation is not an error', () => {
  it('reports a decline as activity, with no error banner', async () => {
    const controller = controllerWith({
      apply: () => Promise.resolve(declined<WorkspaceChangeSet>()),
    });
    await controller.proposeChange([{ path: 'src/index.ts', content: 'x' }]);
    controller.approveChange();
    await controller.applyChange();

    expect(controller.getState().error).toBeNull();
    expect(controller.getState().activity).toContain('declined');
  });

  it('reports a denial as an error, which is a different thing entirely', async () => {
    const controller = controllerWith({
      apply: () => Promise.resolve(denied<WorkspaceChangeSet>()),
    });
    await controller.proposeChange([{ path: 'src/index.ts', content: 'x' }]);
    controller.approveChange();
    await controller.applyChange();

    expect(controller.getState().error?.message).toContain('emergency stop');
  });
});

describe('rollback', () => {
  it('does nothing when there is no applied change to undo', async () => {
    const rollback = vi.fn(() => Promise.resolve(ok(APPLIED)));
    const controller = controllerWith({ rollback });
    await controller.rollbackLatest();
    expect(rollback).not.toHaveBeenCalled();
  });

  it('undoes the change the history names as the target', async () => {
    const rollback = vi.fn(() =>
      Promise.resolve(ok({ ...APPLIED, status: 'rolled-back' as const })),
    );
    const controller = controllerWith({ rollback });
    await controller.refreshChanges();
    await controller.rollbackLatest();

    expect(rollback).toHaveBeenCalledWith(APPLIED.id);
    expect(controller.getState().change?.status).toBe('rolled-back');
  });
});

describe('commands', () => {
  it('reads the catalog', async () => {
    const controller = controllerWith();
    await controller.refreshCommands();
    expect(controller.getState().commands?.commands[0]?.id).toBe('test');
  });

  it('sends an identifier from the enum, never a command line', async () => {
    // Typed with the real signature rather than inferred from the stub, so
    // the assertion below can actually see the arguments.
    const runCommand = vi.fn<WorkspaceClient['runCommand']>(() => Promise.resolve(ok(RUN)));
    const controller = controllerWith({ runCommand });
    await controller.runCommand('test');

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand.mock.calls[0]?.[1]).toBe('test');
  });

  it('records which run is in flight so it can be cancelled', async () => {
    const pending = deferred<WorkspaceResult<CommandRunResult>>();
    const controller = controllerWith({ runCommand: () => pending.promise });

    const running = controller.runCommand('test');
    expect(controller.getState().runningCommand?.commandId).toBe('test');
    expect(controller.getState().busy).toBe('run');

    pending.resolve(ok(RUN));
    await running;
    expect(controller.getState().runningCommand).toBeNull();
    expect(controller.getState().busy).toBeNull();
  });

  it('cancels the run that is actually in flight', async () => {
    // Cancellation must work *while* the controller is busy, which is exactly
    // when every other operation is refused.
    const pending = deferred<WorkspaceResult<CommandRunResult>>();
    const cancelCommand = vi.fn(() => Promise.resolve());
    const controller = controllerWith({ cancelCommand, runCommand: () => pending.promise });

    const running = controller.runCommand('test');
    await controller.cancelCommand();
    expect(cancelCommand).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222');

    pending.resolve(ok(RUN));
    await running;
  });

  it('does not cancel when nothing is running', async () => {
    const cancelCommand = vi.fn(() => Promise.resolve());
    const controller = controllerWith({ cancelCommand });
    await controller.cancelCommand();
    expect(cancelCommand).not.toHaveBeenCalled();
  });

  it('describes a stopped run as stopped, never as a failure', async () => {
    const controller = controllerWith({
      runCommand: () =>
        Promise.resolve(
          ok({ ...RUN, outcome: 'stopped' as const, exitCode: null, timedOut: true }),
        ),
    });
    await controller.runCommand('test');
    expect(controller.getState().activity).toContain('time limit');
  });

  it('asks a running command to stop when the interface goes away', async () => {
    // A read simply has its result discarded on arrival. A command holds a
    // real process, so unmounting must actually try to end it.
    const pending = deferred<WorkspaceResult<CommandRunResult>>();
    const cancelCommand = vi.fn(() => Promise.resolve());
    const controller = controllerWith({ cancelCommand, runCommand: () => pending.promise });

    const running = controller.runCommand('test');
    controller.dispose();
    expect(cancelCommand).toHaveBeenCalledTimes(1);

    pending.resolve(ok(RUN));
    await running;
  });
});

describe('git', () => {
  it('reads status and reports a clean tree', async () => {
    const controller = controllerWith({
      gitStatus: () => Promise.resolve(ok({ ...GIT_STATUS, entries: [], clean: true })),
    });
    await controller.refreshGitStatus();
    expect(controller.getState().activity).toContain('clean');
  });

  it('reads the whole-tree diff by default', async () => {
    const gitDiff = vi.fn(() => Promise.resolve(ok(GIT_DIFF)));
    const controller = controllerWith({ gitDiff });
    await controller.refreshGitDiff();
    expect(gitDiff).toHaveBeenCalledWith(null);
  });

  it('refreshes status after a checkpoint, so the interface stops showing stale changes', async () => {
    const gitStatus = vi.fn(() => Promise.resolve(ok(GIT_STATUS)));
    const controller = controllerWith({ gitStatus });
    await controller.createCheckpoint();
    expect(controller.getState().checkpoint?.commit).toBe('abc1234');
    expect(gitStatus).toHaveBeenCalledTimes(1);
  });

  it('surfaces a repository that is not a working tree as a plain message', async () => {
    const controller = controllerWith({
      gitStatus: () => Promise.resolve(errored<GitStatusValue>('GIT_NOT_A_REPOSITORY')),
    });
    await controller.refreshGitStatus();
    expect(controller.getState().error?.message).toContain('not the root of a Git working tree');
    expect(controller.getState().error?.retryable).toBe(false);
  });
});

describe('selecting a new project invalidates everything from the old one', () => {
  it('drops the pending change, the history, the commands and the git state', async () => {
    const controller = controllerWith();
    await controller.proposeChange([{ path: 'src/index.ts', content: 'x' }]);
    controller.approveChange();
    await controller.refreshChanges();
    await controller.refreshCommands();
    await controller.refreshGitStatus();

    await controller.selectProject();

    const state = controller.getState();
    expect(state.change).toBeNull();
    expect(state.changeApproved).toBe(false);
    expect(state.history).toBeNull();
    expect(state.commands).toBeNull();
    expect(state.gitStatus).toBeNull();
  });
});
