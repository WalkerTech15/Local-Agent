import { describe, expect, it } from 'vitest';

import {
  MEMORY_CATEGORIES,
  MEMORY_CONFIDENCE_MAX,
  MEMORY_CONTENT_MAX_LENGTH,
  MEMORY_IMPORTANCE_MAX,
  MEMORY_MAX_RECORDS_PER_SCOPE,
  MEMORY_MAX_RETRIEVED,
  MEMORY_SCHEMA_VERSION,
  MEMORY_SCOPES,
  MEMORY_SOURCES,
} from '../../../src/shared/constants';
import {
  createEmptyMemoryStore,
  MEMORY_EXPORT_KIND,
  memoryExportSchema,
  memoryRecordInputSchema,
  memoryRecordSchema,
  memoryRetrievalResultSchema,
  memoryStoreSchema,
} from '../../../src/shared/schemas/memory.schema';

const NOW = '2026-01-01T00:00:00.000Z';
const ID = '11111111-1111-4111-8111-111111111111';

function validInput() {
  return {
    scope: 'personal' as const,
    category: 'user-preference' as const,
    content: 'Prefers concise answers.',
    importance: 3,
    confidence: 90,
    expiresAt: null,
    pinned: false,
  };
}

function validRecord(overrides: Record<string, unknown> = {}) {
  return {
    ...validInput(),
    id: ID,
    source: 'user' as const,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('memory record input', () => {
  it('accepts a well-formed record', () => {
    expect(memoryRecordInputSchema.safeParse(validInput()).success).toBe(true);
  });

  it('has no source field, so a caller cannot claim its own provenance', () => {
    const result = memoryRecordInputSchema.safeParse({ ...validInput(), source: 'user' });
    expect(result.success).toBe(false);
  });

  it('has no id or timestamp field, so a caller cannot choose either', () => {
    expect(memoryRecordInputSchema.safeParse({ ...validInput(), id: ID }).success).toBe(false);
    expect(memoryRecordInputSchema.safeParse({ ...validInput(), createdAt: NOW }).success).toBe(
      false,
    );
  });

  it('rejects any field capable of carrying a credential', () => {
    for (const field of ['apiKey', 'token', 'password', 'secret', 'authorization']) {
      const result = memoryRecordInputSchema.safeParse({ ...validInput(), [field]: 'x' });
      expect(result.success, field).toBe(false);
    }
  });

  it('declares no field that could name a permission, a tool or a path', () => {
    const declared = Object.keys(validInput()).sort();
    expect(declared).toEqual([
      'category',
      'confidence',
      'content',
      'expiresAt',
      'importance',
      'pinned',
      'scope',
    ]);
  });

  it('rejects empty or whitespace-only content', () => {
    expect(memoryRecordInputSchema.safeParse({ ...validInput(), content: '' }).success).toBe(false);
    expect(memoryRecordInputSchema.safeParse({ ...validInput(), content: '   ' }).success).toBe(
      false,
    );
  });

  it('trims content', () => {
    const result = memoryRecordInputSchema.parse({ ...validInput(), content: '  note  ' });
    expect(result.content).toBe('note');
  });

  it('bounds content length', () => {
    const tooLong = 'a'.repeat(MEMORY_CONTENT_MAX_LENGTH + 1);
    expect(memoryRecordInputSchema.safeParse({ ...validInput(), content: tooLong }).success).toBe(
      false,
    );
  });

  it('permits newlines and tabs but refuses other control characters', () => {
    expect(memoryRecordInputSchema.safeParse({ ...validInput(), content: 'a\nb\tc' }).success).toBe(
      true,
    );
    expect(
      memoryRecordInputSchema.safeParse({ ...validInput(), content: 'a\u0007b' }).success,
    ).toBe(false);
  });

  it('refuses bidirectional overrides in content', () => {
    expect(
      memoryRecordInputSchema.safeParse({ ...validInput(), content: 'safe\u202Eevil' }).success,
    ).toBe(false);
  });

  it('bounds importance and confidence to their declared ranges', () => {
    expect(memoryRecordInputSchema.safeParse({ ...validInput(), importance: 0 }).success).toBe(
      false,
    );
    expect(
      memoryRecordInputSchema.safeParse({ ...validInput(), importance: MEMORY_IMPORTANCE_MAX + 1 })
        .success,
    ).toBe(false);
    expect(memoryRecordInputSchema.safeParse({ ...validInput(), confidence: -1 }).success).toBe(
      false,
    );
    expect(
      memoryRecordInputSchema.safeParse({ ...validInput(), confidence: MEMORY_CONFIDENCE_MAX + 1 })
        .success,
    ).toBe(false);
  });

  it('refuses a non-integer importance', () => {
    expect(memoryRecordInputSchema.safeParse({ ...validInput(), importance: 2.5 }).success).toBe(
      false,
    );
  });

  it('accepts every declared scope and category, and nothing else', () => {
    for (const scope of MEMORY_SCOPES) {
      expect(memoryRecordInputSchema.safeParse({ ...validInput(), scope }).success, scope).toBe(
        true,
      );
    }
    for (const category of MEMORY_CATEGORIES) {
      expect(
        memoryRecordInputSchema.safeParse({ ...validInput(), category }).success,
        category,
      ).toBe(true);
    }
    expect(memoryRecordInputSchema.safeParse({ ...validInput(), scope: 'global' }).success).toBe(
      false,
    );
    expect(
      memoryRecordInputSchema.safeParse({ ...validInput(), category: 'anything' }).success,
    ).toBe(false);
  });

  it('requires expiresAt to be an ISO datetime or null', () => {
    expect(memoryRecordInputSchema.safeParse({ ...validInput(), expiresAt: NOW }).success).toBe(
      true,
    );
    expect(
      memoryRecordInputSchema.safeParse({ ...validInput(), expiresAt: 'someday' }).success,
    ).toBe(false);
  });
});

describe('memory record', () => {
  it('accepts a stored record', () => {
    expect(memoryRecordSchema.safeParse(validRecord()).success).toBe(true);
  });

  it('accepts only the two declared sources', () => {
    for (const source of MEMORY_SOURCES) {
      expect(memoryRecordSchema.safeParse(validRecord({ source })).success, source).toBe(true);
    }
  });

  it('has no source a model could be recorded under', () => {
    for (const source of ['model', 'assistant', 'chat', 'agent', 'inferred']) {
      expect(memoryRecordSchema.safeParse(validRecord({ source })).success, source).toBe(false);
    }
  });

  it('requires a uuid id', () => {
    expect(memoryRecordSchema.safeParse(validRecord({ id: 'not-a-uuid' })).success).toBe(false);
  });
});

describe('memory store', () => {
  it('accepts an empty store for every scope', () => {
    for (const scope of MEMORY_SCOPES) {
      expect(memoryStoreSchema.safeParse(createEmptyMemoryStore(scope)).success, scope).toBe(true);
    }
  });

  it('pins the schema version', () => {
    const store = {
      ...createEmptyMemoryStore('personal'),
      schemaVersion: MEMORY_SCHEMA_VERSION + 1,
    };
    expect(memoryStoreSchema.safeParse(store).success).toBe(false);
  });

  it('refuses a record whose scope disagrees with the document', () => {
    const store = {
      ...createEmptyMemoryStore('personal'),
      records: [validRecord({ scope: 'project' })],
    };
    expect(memoryStoreSchema.safeParse(store).success).toBe(false);
  });

  it('refuses two records under one id', () => {
    const store = {
      ...createEmptyMemoryStore('personal'),
      records: [validRecord(), validRecord()],
    };
    expect(memoryStoreSchema.safeParse(store).success).toBe(false);
  });

  it('refuses an unknown top-level field', () => {
    const store = { ...createEmptyMemoryStore('personal'), projectPath: 'C:/secret' };
    expect(memoryStoreSchema.safeParse(store).success).toBe(false);
  });

  it('bounds how many records one store may hold', () => {
    const records = Array.from({ length: MEMORY_MAX_RECORDS_PER_SCOPE + 1 }, (_value, index) =>
      validRecord({ id: `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111` }),
    );
    const store = { ...createEmptyMemoryStore('personal'), records };
    expect(memoryStoreSchema.safeParse(store).success).toBe(false);
  });
});

describe('memory export', () => {
  function validExport(overrides: Record<string, unknown> = {}) {
    return {
      kind: MEMORY_EXPORT_KIND,
      schemaVersion: MEMORY_SCHEMA_VERSION,
      exportedAt: NOW,
      scope: 'personal' as const,
      records: [validRecord()],
      ...overrides,
    };
  }

  it('accepts a well-formed export', () => {
    expect(memoryExportSchema.safeParse(validExport()).success).toBe(true);
  });

  it('refuses a document without the kind marker', () => {
    expect(memoryExportSchema.safeParse(validExport({ kind: 'something-else' })).success).toBe(
      false,
    );
    const { kind: _kind, ...withoutKind } = validExport();
    expect(memoryExportSchema.safeParse(withoutKind).success).toBe(false);
  });

  it('declares no field naming where the records came from', () => {
    const declared = Object.keys(validExport()).sort();
    expect(declared).toEqual(['exportedAt', 'kind', 'records', 'schemaVersion', 'scope']);
    for (const field of ['projectPath', 'projectName', 'machine', 'user', 'path']) {
      expect(memoryExportSchema.safeParse(validExport({ [field]: 'x' })).success, field).toBe(
        false,
      );
    }
  });

  it('applies the same cross-record rules as the store', () => {
    expect(
      memoryExportSchema.safeParse(validExport({ records: [validRecord({ scope: 'session' })] }))
        .success,
    ).toBe(false);
  });
});

describe('memory retrieval result', () => {
  it('cannot carry more than the retrieval cap, whatever a caller asks for', () => {
    const records = Array.from({ length: MEMORY_MAX_RETRIEVED + 1 }, (_value, index) =>
      validRecord({ id: `${String(index).padStart(8, '0')}-2222-4222-8222-222222222222` }),
    );
    expect(memoryRetrievalResultSchema.safeParse({ records, considered: 99 }).success).toBe(false);
  });
});
