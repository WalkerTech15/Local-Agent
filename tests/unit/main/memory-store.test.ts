import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MEMORY_PROJECT_KEY_LENGTH,
  MEMORY_SCHEMA_VERSION,
  MEMORY_STORE_MAX_BYTES,
} from '../../../src/shared/constants';
import {
  createSessionMemoryStore,
  loadMemoryStore,
  memoryProjectKey,
  resolveProjectMemoryFile,
  writeMemoryStore,
} from '../../../src/main/memory-store';
import { createEmptyMemoryStore } from '../../../src/shared/schemas/memory.schema';
import type { MemoryRecord, MemoryStore } from '../../../src/shared/schemas/memory.schema';

let dir: string;
let storeFile: string;

const NOW = '2026-01-01T00:00:00.000Z';

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    scope: 'personal',
    category: 'user-preference',
    content: 'Prefers concise answers.',
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

function storeWith(records: readonly MemoryRecord[]): MemoryStore {
  return { schemaVersion: MEMORY_SCHEMA_VERSION, scope: 'personal', records: [...records] };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'local-agent-memory-'));
  storeFile = join(dir, 'memory', 'personal.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loading fails safe', () => {
  it('returns an empty store when the file does not exist, and creates nothing', async () => {
    const store = await loadMemoryStore(storeFile, 'personal');
    expect(store).toEqual(createEmptyMemoryStore('personal'));
    await expect(readdir(join(dir, 'memory'))).rejects.toThrow();
  });

  it('returns an empty store for malformed JSON', async () => {
    await mkdir(join(dir, 'memory'), { recursive: true });
    await writeFile(storeFile, '{ not json', 'utf8');
    expect(await loadMemoryStore(storeFile, 'personal')).toEqual(
      createEmptyMemoryStore('personal'),
    );
  });

  it('returns an empty store rather than merging a partly-valid document', async () => {
    await mkdir(join(dir, 'memory'), { recursive: true });
    const document = {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      scope: 'personal',
      records: [record({ content: 'good' }), { id: 'broken' }],
    };
    await writeFile(storeFile, JSON.stringify(document), 'utf8');
    expect((await loadMemoryStore(storeFile, 'personal')).records).toHaveLength(0);
  });

  it('refuses a document carrying a prototype-polluting key', async () => {
    await mkdir(join(dir, 'memory'), { recursive: true });
    await writeFile(
      storeFile,
      '{"schemaVersion":1,"scope":"personal","records":[],"__proto__":{"polluted":true}}',
      'utf8',
    );
    expect(await loadMemoryStore(storeFile, 'personal')).toEqual(
      createEmptyMemoryStore('personal'),
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses a file larger than the cap', async () => {
    await mkdir(join(dir, 'memory'), { recursive: true });
    const padding = 'x'.repeat(MEMORY_STORE_MAX_BYTES + 10);
    await writeFile(storeFile, JSON.stringify({ padding }), 'utf8');
    expect(await loadMemoryStore(storeFile, 'personal')).toEqual(
      createEmptyMemoryStore('personal'),
    );
  });

  it('refuses a document declaring a different scope than the one asked for', async () => {
    await mkdir(join(dir, 'memory'), { recursive: true });
    const document = {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      scope: 'project',
      records: [record({ scope: 'project' })],
    };
    await writeFile(storeFile, JSON.stringify(document), 'utf8');
    expect((await loadMemoryStore(storeFile, 'personal')).records).toHaveLength(0);
  });

  it('reads back a document it wrote', async () => {
    const store = storeWith([record()]);
    await writeMemoryStore(storeFile, store);
    expect(await loadMemoryStore(storeFile, 'personal')).toEqual(store);
  });
});

describe('writing is atomic and validated', () => {
  it('refuses to persist a document the schema rejects', async () => {
    const invalid = { ...storeWith([]), records: [record({ scope: 'session' })] };
    await expect(writeMemoryStore(storeFile, invalid)).rejects.toThrow();
  });

  it('leaves no temporary file behind on success', async () => {
    await writeMemoryStore(storeFile, storeWith([record()]));
    const entries = await readdir(join(dir, 'memory'));
    expect(entries.filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  });

  it('creates the directory only on the first write', async () => {
    await expect(readdir(join(dir, 'memory'))).rejects.toThrow();
    await writeMemoryStore(storeFile, storeWith([]));
    expect(await readdir(join(dir, 'memory'))).toContain('personal.json');
  });

  it('replaces the previous document rather than appending to it', async () => {
    await writeMemoryStore(storeFile, storeWith([record({ content: 'first' })]));
    await writeMemoryStore(storeFile, storeWith([record({ content: 'second' })]));
    const raw = await readFile(storeFile, 'utf8');
    expect(raw).toContain('second');
    expect(raw).not.toContain('first');
  });
});

describe('project addressing', () => {
  it('derives a fixed-length hexadecimal key', () => {
    const key = memoryProjectKey('C:\\Work\\App');
    expect(key).toHaveLength(MEMORY_PROJECT_KEY_LENGTH);
    expect(key).toMatch(/^[0-9a-f]+$/);
  });

  it('never contains the path it was derived from', () => {
    expect(memoryProjectKey('C:\\Users\\someone\\Secret-Client')).not.toContain('Secret');
    expect(memoryProjectKey('C:\\Users\\someone\\Secret-Client')).not.toContain('someone');
  });

  it('maps two different projects to two different files', () => {
    const a = resolveProjectMemoryFile('/base', 'C:\\Work\\AppOne');
    const b = resolveProjectMemoryFile('/base', 'C:\\Work\\AppTwo');
    expect(a).not.toBe(b);
  });

  it('maps case-different spellings of one Windows path to the same file', () => {
    expect(memoryProjectKey('C:\\Work\\App')).toBe(memoryProjectKey('c:\\work\\app'));
  });

  it('is stable across calls', () => {
    expect(memoryProjectKey('/home/dev/app')).toBe(memoryProjectKey('/home/dev/app'));
  });

  it('keeps two projects’ records in separate files', async () => {
    const projectsDir = join(dir, 'memory', 'projects');
    const fileA = resolveProjectMemoryFile(projectsDir, '/projects/a');
    const fileB = resolveProjectMemoryFile(projectsDir, '/projects/b');

    const projectRecord = (content: string): MemoryStore => ({
      schemaVersion: MEMORY_SCHEMA_VERSION,
      scope: 'project',
      records: [record({ scope: 'project', content })],
    });

    await writeMemoryStore(fileA, projectRecord('note for A'));
    await writeMemoryStore(fileB, projectRecord('note for B'));

    expect((await loadMemoryStore(fileA, 'project')).records[0]?.content).toBe('note for A');
    expect((await loadMemoryStore(fileB, 'project')).records[0]?.content).toBe('note for B');
  });
});

describe('session store', () => {
  it('starts empty and in the session scope', () => {
    expect(createSessionMemoryStore().read()).toEqual(createEmptyMemoryStore('session'));
  });

  it('holds what it is given for the lifetime of the instance', () => {
    const session = createSessionMemoryStore();
    const store: MemoryStore = {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      scope: 'session',
      records: [record({ scope: 'session' })],
    };
    session.write(store);
    expect(session.read()).toEqual(store);
  });

  it('validates on write, so an invalid document is never served', () => {
    const session = createSessionMemoryStore();
    expect(() => {
      session.write({
        schemaVersion: MEMORY_SCHEMA_VERSION,
        scope: 'session',
        records: [record({ scope: 'personal' })],
      });
    }).toThrow();
  });

  it('gives each instance its own state, so one cannot leak into another', () => {
    const first = createSessionMemoryStore();
    const second = createSessionMemoryStore();
    first.write({
      schemaVersion: MEMORY_SCHEMA_VERSION,
      scope: 'session',
      records: [record({ scope: 'session' })],
    });
    expect(second.read().records).toHaveLength(0);
  });
});
