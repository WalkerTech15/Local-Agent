import { beforeEach, describe, expect, it } from 'vitest';

import {
  MEMORY_MAX_RECORDS_PER_SCOPE,
  MEMORY_MAX_RETRIEVED,
  MEMORY_SCHEMA_VERSION,
} from '../../../src/shared/constants';
import type { MemoryScope } from '../../../src/shared/constants';
import { MemoryError } from '../../../src/shared/memory/errors';
import {
  addMemory,
  buildMemoryExport,
  clearMemoryScope,
  deleteMemory,
  importMemoryRecords,
  listMemories,
  retrieveRelevantMemories,
  searchMemoryScope,
  setMemoryPinned,
  updateMemory,
} from '../../../src/main/memory-service';
import type { MemoryStoreAccess } from '../../../src/main/memory-service';
import {
  createEmptyMemoryStore,
  MEMORY_EXPORT_KIND,
} from '../../../src/shared/schemas/memory.schema';
import type {
  MemoryRecord,
  MemoryRecordInput,
  MemoryStore,
} from '../../../src/shared/schemas/memory.schema';

const NOW = '2026-06-01T12:00:00.000Z';
const LATER = '2026-06-02T12:00:00.000Z';

let stores: Map<MemoryScope, MemoryStore>;
let access: MemoryStoreAccess;
let projectApproved: boolean;
let writeFails: boolean;
let idCounter: number;

function newId(): string {
  idCounter += 1;
  return `${String(idCounter).padStart(8, '0')}-0000-4000-8000-000000000000`;
}

function input(overrides: Partial<MemoryRecordInput> = {}): MemoryRecordInput {
  return {
    scope: 'personal',
    category: 'user-preference',
    content: 'Prefers concise answers.',
    importance: 3,
    confidence: 100,
    expiresAt: null,
    pinned: false,
    ...overrides,
  };
}

function seed(scope: MemoryScope, records: readonly MemoryRecord[]): void {
  stores.set(scope, { schemaVersion: MEMORY_SCHEMA_VERSION, scope, records: [...records] });
}

function storedRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: newId(),
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

beforeEach(() => {
  idCounter = 0;
  projectApproved = true;
  writeFails = false;
  stores = new Map([
    ['session', createEmptyMemoryStore('session')],
    ['project', createEmptyMemoryStore('project')],
    ['personal', createEmptyMemoryStore('personal')],
  ]);

  access = {
    read: (scope) => {
      if (scope === 'project' && !projectApproved) {
        return Promise.reject(new MemoryError('MEMORY_NO_PROJECT'));
      }
      return Promise.resolve(stores.get(scope) ?? createEmptyMemoryStore(scope));
    },
    write: (scope, store) => {
      if (scope === 'project' && !projectApproved) {
        return Promise.reject(new MemoryError('MEMORY_NO_PROJECT'));
      }
      if (writeFails) return Promise.reject(new Error('disk on fire at C:\\Users\\someone'));
      stores.set(scope, store);
      return Promise.resolve();
    },
  };
});

describe('adding', () => {
  it('stamps the id, the source and both timestamps', async () => {
    const created = await addMemory(access, input(), NOW, newId);
    expect(created.source).toBe('user');
    expect(created.createdAt).toBe(NOW);
    expect(created.updatedAt).toBe(NOW);
    expect(created.id).toMatch(/^[0-9a-f-]+$/);
  });

  it('persists into the scope the record names', async () => {
    await addMemory(access, input({ scope: 'session' }), NOW, newId);
    expect(stores.get('session')?.records).toHaveLength(1);
    expect(stores.get('personal')?.records).toHaveLength(0);
  });

  it('refuses content that looks like a credential', async () => {
    await expect(
      addMemory(access, input({ content: 'sk-abcdefghijklmnopqrstuvwx' }), NOW, newId),
    ).rejects.toMatchObject({ code: 'MEMORY_SECRET_REJECTED' });
    expect(stores.get('personal')?.records).toHaveLength(0);
  });

  it('refuses a project record when no project is approved', async () => {
    projectApproved = false;
    await expect(addMemory(access, input({ scope: 'project' }), NOW, newId)).rejects.toMatchObject({
      code: 'MEMORY_NO_PROJECT',
    });
  });

  it('refuses once the scope is full', async () => {
    seed(
      'personal',
      Array.from({ length: MEMORY_MAX_RECORDS_PER_SCOPE }, (_value, index) =>
        storedRecord({ content: `note ${String(index)}` }),
      ),
    );
    await expect(addMemory(access, input(), NOW, newId)).rejects.toMatchObject({
      code: 'MEMORY_LIMIT_REACHED',
    });
  });

  it('normalizes a write failure to a code that carries no path', async () => {
    writeFails = true;
    await expect(addMemory(access, input(), NOW, newId)).rejects.toMatchObject({
      code: 'MEMORY_STORE_FAILED',
    });
    // The underlying filesystem message names a path; the normalized error
    // must not carry it, or anything else from the original, across a
    // boundary.
    const thrown: unknown = await addMemory(access, input(), NOW, newId).catch(
      (error: unknown) => error,
    );
    const message = thrown instanceof Error ? thrown.message : '';
    expect(message).not.toContain('C:\\Users');
    expect(message).not.toContain('disk on fire');
  });
});

describe('updating', () => {
  it('carries createdAt and source over, and moves updatedAt on', async () => {
    const existing = storedRecord({ source: 'import', createdAt: NOW });
    seed('personal', [existing]);

    const updated = await updateMemory(access, existing.id, input({ content: 'changed' }), LATER);
    expect(updated.createdAt).toBe(NOW);
    expect(updated.source).toBe('import');
    expect(updated.updatedAt).toBe(LATER);
    expect(updated.content).toBe('changed');
  });

  it('refuses an unknown id', async () => {
    await expect(
      updateMemory(access, '99999999-9999-4999-8999-999999999999', input(), LATER),
    ).rejects.toMatchObject({ code: 'MEMORY_NOT_FOUND' });
  });

  it('cannot move a record to another scope', async () => {
    const existing = storedRecord({ scope: 'personal' });
    seed('personal', [existing]);
    seed('project', []);

    // Addressing the project store finds nothing, so the record stays where
    // it is rather than being relocated.
    await expect(
      updateMemory(access, existing.id, input({ scope: 'project' }), LATER),
    ).rejects.toMatchObject({ code: 'MEMORY_NOT_FOUND' });
    expect(stores.get('personal')?.records).toHaveLength(1);
    expect(stores.get('project')?.records).toHaveLength(0);
  });

  it('refuses content that looks like a credential', async () => {
    const existing = storedRecord();
    seed('personal', [existing]);
    await expect(
      updateMemory(
        access,
        existing.id,
        input({ content: '-----BEGIN RSA PRIVATE KEY-----' }),
        LATER,
      ),
    ).rejects.toMatchObject({ code: 'MEMORY_SECRET_REJECTED' });
  });
});

describe('pinning and deleting', () => {
  it('pins and unpins without changing anything else', async () => {
    const existing = storedRecord({ content: 'keep me' });
    seed('personal', [existing]);

    const pinned = await setMemoryPinned(access, existing.id, 'personal', true, LATER);
    expect(pinned.pinned).toBe(true);
    expect(pinned.content).toBe('keep me');
    expect(pinned.createdAt).toBe(existing.createdAt);
  });

  it('deletes one record and leaves the rest', async () => {
    const gone = storedRecord({ content: 'gone' });
    const kept = storedRecord({ content: 'kept' });
    seed('personal', [gone, kept]);

    const summary = await deleteMemory(access, gone.id, 'personal', LATER);
    expect(summary).toEqual({ scope: 'personal', affected: 1, rejected: 0 });
    expect(stores.get('personal')?.records.map((entry) => entry.content)).toEqual(['kept']);
  });

  it('refuses to delete an id the scope does not hold', async () => {
    await expect(
      deleteMemory(access, '99999999-9999-4999-8999-999999999999', 'personal', LATER),
    ).rejects.toMatchObject({ code: 'MEMORY_NOT_FOUND' });
  });
});

describe('expiry pruning', () => {
  it('drops expired records from the file on the next write', async () => {
    const live = storedRecord({ content: 'live' });
    const stale = storedRecord({ content: 'stale', expiresAt: '2020-01-01T00:00:00.000Z' });
    seed('personal', [live, stale]);

    await setMemoryPinned(access, live.id, 'personal', true, LATER);
    expect(stores.get('personal')?.records.map((entry) => entry.content)).toEqual(['live']);
  });

  it('hides an expired record from a list without writing anything', async () => {
    const stale = storedRecord({ content: 'stale', expiresAt: '2020-01-01T00:00:00.000Z' });
    seed('personal', [stale]);

    const listed = await listMemories(access, 'personal', NOW);
    expect(listed.records).toHaveLength(0);
    expect(listed.total).toBe(0);
    // Still on disk: reads never write.
    expect(stores.get('personal')?.records).toHaveLength(1);
  });
});

describe('reading', () => {
  it('lists a scope with pinned records first', async () => {
    const plain = storedRecord({ content: 'plain', updatedAt: LATER });
    const pinned = storedRecord({ content: 'pinned', pinned: true, updatedAt: NOW });
    seed('personal', [plain, pinned]);

    const listed = await listMemories(access, 'personal', LATER);
    expect(listed.records.map((entry) => entry.content)).toEqual(['pinned', 'plain']);
  });

  it('searches only inside the addressed scope', async () => {
    seed('personal', [storedRecord({ content: 'french documentation' })]);
    seed('project', [storedRecord({ scope: 'project', content: 'french documentation' })]);

    const result = await searchMemoryScope(access, 'project', 'french', NOW);
    expect(result.scope).toBe('project');
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.scope).toBe('project');
  });

  it('retrieves across every readable scope', async () => {
    seed('personal', [storedRecord({ content: 'the parser is hand written' })]);
    seed('project', [storedRecord({ scope: 'project', content: 'parser tests live in tests/' })]);

    const result = await retrieveRelevantMemories(
      access,
      ['personal', 'project', 'session'],
      'improve the parser',
      NOW,
    );
    expect(result.records).toHaveLength(2);
    expect(result.considered).toBe(2);
  });

  it('skips the project scope rather than failing when no project is approved', async () => {
    projectApproved = false;
    seed('personal', [storedRecord({ content: 'the parser is hand written' })]);

    const result = await retrieveRelevantMemories(
      access,
      ['personal', 'project', 'session'],
      'improve the parser',
      NOW,
    );
    expect(result.records).toHaveLength(1);
  });

  it('never returns more than the retrieval cap', async () => {
    seed(
      'personal',
      Array.from({ length: MEMORY_MAX_RETRIEVED + 10 }, (_value, index) =>
        storedRecord({ content: `parser note ${String(index)}` }),
      ),
    );
    const result = await retrieveRelevantMemories(access, ['personal'], 'parser', NOW);
    expect(result.records.length).toBeLessThanOrEqual(MEMORY_MAX_RETRIEVED);
  });
});

describe('clearing', () => {
  it('empties the scope and reports how many went', async () => {
    seed('personal', [storedRecord(), storedRecord()]);
    const summary = await clearMemoryScope(access, 'personal', NOW);
    expect(summary.affected).toBe(2);
    expect(stores.get('personal')?.records).toHaveLength(0);
  });

  it('leaves every other scope untouched', async () => {
    seed('personal', [storedRecord()]);
    seed('session', [storedRecord({ scope: 'session' })]);
    await clearMemoryScope(access, 'personal', NOW);
    expect(stores.get('session')?.records).toHaveLength(1);
  });
});

describe('export', () => {
  it('builds a document carrying only the records and the time', async () => {
    seed('personal', [storedRecord()]);
    const document = await buildMemoryExport(access, 'personal', NOW);

    expect(document.kind).toBe(MEMORY_EXPORT_KIND);
    expect(Object.keys(document).sort()).toEqual([
      'exportedAt',
      'kind',
      'records',
      'schemaVersion',
      'scope',
    ]);
  });

  it('never exports an expired record', async () => {
    seed('personal', [
      storedRecord({ content: 'live' }),
      storedRecord({ content: 'stale', expiresAt: '2020-01-01T00:00:00.000Z' }),
    ]);
    const document = await buildMemoryExport(access, 'personal', NOW);
    expect(document.records.map((entry) => entry.content)).toEqual(['live']);
  });
});

describe('import', () => {
  function exportDocument(records: readonly MemoryRecord[], scope: MemoryScope = 'personal') {
    return {
      kind: MEMORY_EXPORT_KIND,
      schemaVersion: MEMORY_SCHEMA_VERSION,
      exportedAt: NOW,
      scope,
      records,
    };
  }

  it('refuses a file that is merely valid JSON', async () => {
    await expect(
      importMemoryRecords(access, 'personal', { name: 'package', version: '1.0.0' }, NOW, newId),
    ).rejects.toMatchObject({ code: 'MEMORY_IMPORT_INVALID' });
  });

  it('refuses a document whose scope differs from the target', async () => {
    const document = exportDocument([storedRecord({ scope: 'project' })], 'project');
    await expect(
      importMemoryRecords(access, 'personal', document, NOW, newId),
    ).rejects.toMatchObject({ code: 'MEMORY_IMPORT_INVALID' });
  });

  it('re-stamps every accepted record with a fresh id and the import source', async () => {
    const incoming = storedRecord({ content: 'imported note', source: 'user' });
    const summary = await importMemoryRecords(
      access,
      'personal',
      exportDocument([incoming]),
      LATER,
      newId,
    );

    expect(summary.affected).toBe(1);
    const stored = stores.get('personal')?.records[0];
    expect(stored?.source).toBe('import');
    expect(stored?.id).not.toBe(incoming.id);
    expect(stored?.updatedAt).toBe(LATER);
    expect(stored?.createdAt).toBe(incoming.createdAt);
  });

  it('refuses individual records that look like credentials while importing the rest', async () => {
    const good = storedRecord({ content: 'a fine note' });
    const bad = storedRecord({ content: 'ghp_abcdefghijklmnopqrstuvwxyz0123' });

    const summary = await importMemoryRecords(
      access,
      'personal',
      exportDocument([good, bad]),
      LATER,
      newId,
    );
    expect(summary).toEqual({ scope: 'personal', affected: 1, rejected: 1 });
    expect(stores.get('personal')?.records).toHaveLength(1);
  });

  it('does not import a note the scope already holds', async () => {
    seed('personal', [storedRecord({ content: 'Prefers concise answers' })]);
    const duplicate = storedRecord({ content: '  prefers CONCISE answers  ' });

    const summary = await importMemoryRecords(
      access,
      'personal',
      exportDocument([duplicate]),
      LATER,
      newId,
    );
    expect(summary).toEqual({ scope: 'personal', affected: 0, rejected: 1 });
    expect(stores.get('personal')?.records).toHaveLength(1);
  });

  it('refuses outright rather than importing however many happen to fit', async () => {
    seed(
      'personal',
      Array.from({ length: MEMORY_MAX_RECORDS_PER_SCOPE - 1 }, (_value, index) =>
        storedRecord({ content: `existing ${String(index)}` }),
      ),
    );
    const incoming = Array.from({ length: 5 }, (_value, index) =>
      storedRecord({ content: `incoming ${String(index)}` }),
    );

    await expect(
      importMemoryRecords(access, 'personal', exportDocument(incoming), LATER, newId),
    ).rejects.toMatchObject({ code: 'MEMORY_LIMIT_REACHED' });
    expect(stores.get('personal')?.records).toHaveLength(MEMORY_MAX_RECORDS_PER_SCOPE - 1);
  });

  it('refuses a document carrying a record with an unknown source', async () => {
    const document = {
      ...exportDocument([]),
      records: [{ ...storedRecord(), source: 'model' }],
    };
    await expect(
      importMemoryRecords(access, 'personal', document, LATER, newId),
    ).rejects.toMatchObject({ code: 'MEMORY_IMPORT_INVALID' });
  });
});
