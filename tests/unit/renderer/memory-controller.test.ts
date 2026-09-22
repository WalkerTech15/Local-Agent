import { describe, expect, it, vi } from 'vitest';

import { MemoryController } from '../../../src/renderer/memory/memory-controller';
import type { MemoryClient, MemoryResult } from '../../../src/renderer/memory/ipc-memory-client';
import type { MemoryErrorCode } from '../../../src/shared/memory';
import type {
  MemoryMutationSummary,
  MemoryQueryResult,
  MemoryRecord,
  MemoryRecordInput,
  MemoryScopeValue,
} from '../../../src/shared/schemas';

/**
 * The Memory Centre's state machine, driven directly.
 *
 * React Testing Library and jsdom are not part of this project's toolchain,
 * so the behaviours a person actually experiences — loading, empty, error,
 * retry, scope switching, a declined confirmation, a dismissed file dialog —
 * are tested here rather than through a rendered component.
 */

const NOW = '2026-09-14T00:00:00.000Z';

let idCounter = 0;

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  idCounter += 1;
  return {
    id: `${String(idCounter).padStart(8, '0')}-0000-4000-8000-000000000000`,
    scope: 'personal',
    category: 'user-preference',
    content: 'a note',
    source: 'user',
    importance: 3,
    confidence: 100,
    expiresAt: null,
    pinned: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function queryResult(
  records: readonly MemoryRecord[],
  scope: MemoryScopeValue = 'personal',
): MemoryQueryResult {
  return { scope, records: [...records], total: records.length, truncated: false };
}

function ok<TValue>(value: TValue): MemoryResult<TValue> {
  return { ok: true, value };
}

function fails<TValue>(code: MemoryErrorCode): MemoryResult<TValue> {
  return { ok: false, failure: { kind: 'error', code } };
}

const SUMMARY: MemoryMutationSummary = { scope: 'personal', affected: 1, rejected: 0 };

const INPUT: MemoryRecordInput = {
  scope: 'personal',
  category: 'user-preference',
  content: 'a note',
  importance: 3,
  confidence: 100,
  expiresAt: null,
  pinned: false,
};

/** A client whose every operation succeeds and whose lists are configurable. */
function fakeClient(overrides: Partial<MemoryClient> = {}): MemoryClient {
  return {
    list: () => Promise.resolve(ok(queryResult([]))),
    search: () => Promise.resolve(ok(queryResult([]))),
    retrieve: () => Promise.resolve(ok({ records: [], considered: 0 })),
    add: () => Promise.resolve(ok(record())),
    update: () => Promise.resolve(ok(record())),
    setPinned: () => Promise.resolve(ok(record({ pinned: true }))),
    remove: () => Promise.resolve(ok(SUMMARY)),
    clear: () => Promise.resolve(ok({ ...SUMMARY, affected: 3 })),
    exportScope: () => Promise.resolve(ok(SUMMARY)),
    importScope: () => Promise.resolve(ok(SUMMARY)),
    ...overrides,
  };
}

describe('initial state', () => {
  it('starts uninitialised, idle and empty', () => {
    const controller = new MemoryController({ client: fakeClient() });
    const state = controller.getState();
    expect(state.initialized).toBe(false);
    expect(state.records).toEqual([]);
    expect(state.busy).toBeNull();
    expect(state.error).toBeNull();
  });

  it('defaults to the personal scope, which is always available', () => {
    expect(new MemoryController({ client: fakeClient() }).getState().scope).toBe('personal');
  });

  it('loads on initialize and marks itself initialised even when empty', async () => {
    const controller = new MemoryController({ client: fakeClient() });
    await controller.initialize();
    expect(controller.getState().initialized).toBe(true);
    expect(controller.getState().records).toEqual([]);
  });

  it('marks itself initialised even when the first load fails', async () => {
    const controller = new MemoryController({
      client: fakeClient({ list: () => Promise.resolve(fails('MEMORY_READ_FAILED')) }),
    });
    await controller.initialize();
    expect(controller.getState().initialized).toBe(true);
    expect(controller.getState().error).not.toBeNull();
  });

  it('does not load twice', async () => {
    const list = vi.fn(() => Promise.resolve(ok(queryResult([]))));
    const controller = new MemoryController({ client: fakeClient({ list }) });
    await controller.initialize();
    await controller.initialize();
    expect(list).toHaveBeenCalledTimes(1);
  });
});

describe('listing and searching', () => {
  it('shows what a list returned', async () => {
    const records = [record({ content: 'one' }), record({ content: 'two' })];
    const controller = new MemoryController({
      client: fakeClient({ list: () => Promise.resolve(ok(queryResult(records))) }),
    });
    await controller.initialize();
    expect(controller.getState().records.map((entry) => entry.content)).toEqual(['one', 'two']);
    expect(controller.getState().total).toBe(2);
  });

  it('records the query a search was produced by', async () => {
    const controller = new MemoryController({ client: fakeClient() });
    await controller.initialize();
    await controller.search('french');
    expect(controller.getState().query).toBe('french');
  });

  it('treats an empty search as "show everything"', async () => {
    const search = vi.fn(() => Promise.resolve(ok(queryResult([]))));
    const controller = new MemoryController({ client: fakeClient({ search }) });
    await controller.initialize();
    await controller.search('   ');
    expect(search).not.toHaveBeenCalled();
    expect(controller.getState().query).toBe('');
  });

  it('repeats the search, not the plain list, when refreshed', async () => {
    const search = vi.fn(() => Promise.resolve(ok(queryResult([]))));
    const controller = new MemoryController({ client: fakeClient({ search }) });
    await controller.initialize();
    await controller.search('french');
    await controller.refresh();
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('goes back to the whole scope when the search is cleared', async () => {
    const controller = new MemoryController({ client: fakeClient() });
    await controller.initialize();
    await controller.search('french');
    await controller.clearSearch();
    expect(controller.getState().query).toBe('');
  });
});

describe('scope switching', () => {
  it('asks for the new scope', async () => {
    const list = vi.fn((scope: MemoryScopeValue) => Promise.resolve(ok(queryResult([], scope))));
    const controller = new MemoryController({ client: fakeClient({ list }) });
    await controller.initialize();
    await controller.setScope('session');
    expect(controller.getState().scope).toBe('session');
    expect(list).toHaveBeenLastCalledWith('session');
  });

  it('discards the previous scope’s records before the new request answers', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });

    const controller = new MemoryController({
      client: fakeClient({
        list: (scope) => {
          if (scope === 'personal') return Promise.resolve(ok(queryResult([record()])));
          return pending.then(() => ok(queryResult([], scope)));
        },
      }),
    });

    await controller.initialize();
    expect(controller.getState().records).toHaveLength(1);

    const switching = controller.setScope('project');
    // Already cleared, before the project list has answered: one project's
    // notes are never shown under another's heading.
    expect(controller.getState().records).toHaveLength(0);
    expect(controller.getState().initialized).toBe(false);

    release();
    await switching;
    expect(controller.getState().initialized).toBe(true);
  });

  it('clears any active search when the scope changes', async () => {
    const controller = new MemoryController({ client: fakeClient() });
    await controller.initialize();
    await controller.search('french');
    await controller.setScope('session');
    expect(controller.getState().query).toBe('');
  });

  it('reports the no-project refusal in its own words', async () => {
    const controller = new MemoryController({
      client: fakeClient({
        list: (scope) =>
          scope === 'project'
            ? Promise.resolve(fails<MemoryQueryResult>('MEMORY_NO_PROJECT'))
            : Promise.resolve(ok(queryResult([]))),
      }),
    });
    await controller.initialize();
    await controller.setScope('project');
    expect(controller.getState().error?.message).toContain('No project is open');
    expect(controller.getState().error?.retryable).toBe(false);
  });
});

describe('writes reload rather than guessing', () => {
  it('re-reads the list after a successful add', async () => {
    const list = vi.fn(() => Promise.resolve(ok(queryResult([]))));
    const controller = new MemoryController({ client: fakeClient({ list }) });
    await controller.initialize();
    await controller.addMemory(INPUT);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('reports what the write did, not what the reload did', async () => {
    const controller = new MemoryController({ client: fakeClient() });
    await controller.initialize();
    await controller.addMemory(INPUT);
    expect(controller.getState().activity).toBe('Memory saved.');
  });

  it('does not reload when the write failed', async () => {
    const list = vi.fn(() => Promise.resolve(ok(queryResult([]))));
    const controller = new MemoryController({
      client: fakeClient({ list, add: () => Promise.resolve(fails('MEMORY_INVALID')) }),
    });
    await controller.initialize();
    await controller.addMemory(INPUT);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('addresses pin and delete in the scope currently shown', async () => {
    const setPinned = vi.fn(() => Promise.resolve(ok(record({ pinned: true }))));
    const controller = new MemoryController({ client: fakeClient({ setPinned }) });
    await controller.initialize();
    await controller.setScope('session');
    await controller.setPinned('some-id', true);
    expect(setPinned).toHaveBeenCalledWith('some-id', 'session', true);
  });
});

describe('failures are shown in this file’s own words', () => {
  it('never displays a code', async () => {
    const controller = new MemoryController({
      client: fakeClient({ add: () => Promise.resolve(fails('MEMORY_STORE_FAILED')) }),
    });
    await controller.initialize();
    await controller.addMemory(INPUT);
    expect(controller.getState().error?.message).not.toContain('MEMORY_');
  });

  it('explains a rejected credential without repeating it', async () => {
    const controller = new MemoryController({
      client: fakeClient({ add: () => Promise.resolve(fails('MEMORY_SECRET_REJECTED')) }),
    });
    await controller.initialize();
    await controller.addMemory(INPUT);
    expect(controller.getState().error?.message).toContain('key, token or password');
    expect(controller.getState().error?.retryable).toBe(false);
  });

  it('offers retry only where retrying could help', async () => {
    const controller = new MemoryController({
      client: fakeClient({ add: () => Promise.resolve(fails('MEMORY_STORE_FAILED')) }),
    });
    await controller.initialize();
    await controller.addMemory(INPUT);
    expect(controller.getState().error?.retryable).toBe(true);
  });

  it('treats a denial as an error and a decline as an activity note', async () => {
    const denied = new MemoryController({
      client: fakeClient({
        clear: () => Promise.resolve({ ok: false, failure: { kind: 'denied' } }),
      }),
    });
    await denied.initialize();
    await denied.clearScope();
    expect(denied.getState().error).not.toBeNull();

    const declined = new MemoryController({
      client: fakeClient({
        clear: () => Promise.resolve({ ok: false, failure: { kind: 'declined' } }),
      }),
    });
    await declined.initialize();
    await declined.clearScope();
    expect(declined.getState().error).toBeNull();
    expect(declined.getState().activity).toContain('declined');
  });

  it('treats a dismissed file dialog as an activity note, not an error', async () => {
    const controller = new MemoryController({
      client: fakeClient({
        exportScope: () => Promise.resolve(fails('MEMORY_FILE_SELECTION_CANCELLED')),
      }),
    });
    await controller.initialize();
    await controller.exportScope();
    expect(controller.getState().error).toBeNull();
    expect(controller.getState().activity).toContain('No file was chosen');
  });

  it('dismisses an error on request', async () => {
    const controller = new MemoryController({
      client: fakeClient({ add: () => Promise.resolve(fails('MEMORY_STORE_FAILED')) }),
    });
    await controller.initialize();
    await controller.addMemory(INPUT);
    controller.dismissError();
    expect(controller.getState().error).toBeNull();
  });

  it('retries the operation that failed', async () => {
    const add = vi
      .fn<MemoryClient['add']>()
      .mockResolvedValueOnce(fails('MEMORY_STORE_FAILED'))
      .mockResolvedValueOnce(ok(record()));
    const controller = new MemoryController({ client: fakeClient({ add }) });
    await controller.initialize();
    await controller.addMemory(INPUT);
    await controller.retry();
    expect(add).toHaveBeenCalledTimes(2);
    expect(controller.getState().error).toBeNull();
  });
});

describe('concurrency and lifetime', () => {
  it('ignores a second request while one is in flight', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const list = vi.fn(() => pending.then(() => ok(queryResult([]))));
    const controller = new MemoryController({ client: fakeClient({ list }) });

    const first = controller.initialize();
    await controller.search('french');
    expect(controller.getState().busy).toBe('list');

    release();
    await first;
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('discards a response that is no longer current', async () => {
    let release!: (value: MemoryResult<MemoryQueryResult>) => void;
    const stale = new Promise<MemoryResult<MemoryQueryResult>>((resolve) => {
      release = resolve;
    });

    const controller = new MemoryController({
      client: fakeClient({ list: () => stale }),
    });

    const pendingInit = controller.initialize();
    controller.dispose();
    release(ok(queryResult([record({ content: 'too late' })])));
    await pendingInit;

    expect(controller.getState().records).toEqual([]);
  });

  it('stops notifying listeners once disposed', async () => {
    const listener = vi.fn();
    const controller = new MemoryController({ client: fakeClient() });
    controller.subscribe(listener);
    controller.dispose();
    await controller.initialize();
    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies subscribers on every state change', async () => {
    const listener = vi.fn();
    const controller = new MemoryController({ client: fakeClient() });
    controller.subscribe(listener);
    await controller.initialize();
    expect(listener.mock.calls.length).toBeGreaterThan(1);
  });

  it('stops notifying an unsubscribed listener', async () => {
    const listener = vi.fn();
    const controller = new MemoryController({ client: fakeClient() });
    const unsubscribe = controller.subscribe(listener);
    unsubscribe();
    await controller.initialize();
    expect(listener).not.toHaveBeenCalled();
  });
});
