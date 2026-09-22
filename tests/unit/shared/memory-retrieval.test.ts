import { describe, expect, it } from 'vitest';

import { MEMORY_MAX_RETRIEVED } from '../../../src/shared/constants';
import {
  activeMemories,
  dedupeMemories,
  isMemoryExpired,
  orderMemories,
  retrieveMemories,
  searchMemories,
} from '../../../src/shared/memory/retrieval';
import type { MemoryRecord } from '../../../src/shared/schemas/memory.schema';

const NOW = '2026-06-01T12:00:00.000Z';

let counter = 0;

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  counter += 1;
  return {
    id: `${String(counter).padStart(8, '0')}-0000-4000-8000-000000000000`,
    scope: 'personal',
    category: 'user-preference',
    content: 'a note',
    source: 'user',
    importance: 3,
    confidence: 100,
    expiresAt: null,
    pinned: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('expiry', () => {
  it('treats a record with no expiry as never expiring', () => {
    expect(isMemoryExpired(record(), NOW)).toBe(false);
  });

  it('treats a past expiry as expired and a future one as not', () => {
    expect(isMemoryExpired(record({ expiresAt: '2026-05-31T00:00:00.000Z' }), NOW)).toBe(true);
    expect(isMemoryExpired(record({ expiresAt: '2026-06-02T00:00:00.000Z' }), NOW)).toBe(false);
  });

  it('treats the exact expiry instant as expired', () => {
    expect(isMemoryExpired(record({ expiresAt: NOW }), NOW)).toBe(true);
  });

  it('treats an unparseable expiry as expired, not as "no expiry"', () => {
    expect(isMemoryExpired(record({ expiresAt: 'whenever' }), NOW)).toBe(true);
  });

  it('filters expired records out of a list', () => {
    const kept = record({ content: 'kept' });
    const gone = record({ content: 'gone', expiresAt: '2020-01-01T00:00:00.000Z' });
    expect(activeMemories([kept, gone], NOW).map((entry) => entry.content)).toEqual(['kept']);
  });
});

describe('ordering', () => {
  it('puts pinned records first', () => {
    const plain = record({ content: 'plain', updatedAt: '2026-05-01T00:00:00.000Z' });
    const pinned = record({
      content: 'pinned',
      pinned: true,
      updatedAt: '2020-01-01T00:00:00.000Z',
    });
    expect(orderMemories([plain, pinned]).map((entry) => entry.content)).toEqual([
      'pinned',
      'plain',
    ]);
  });

  it('orders the rest by most recently updated', () => {
    const older = record({ content: 'older', updatedAt: '2026-01-01T00:00:00.000Z' });
    const newer = record({ content: 'newer', updatedAt: '2026-05-01T00:00:00.000Z' });
    expect(orderMemories([older, newer]).map((entry) => entry.content)).toEqual(['newer', 'older']);
  });

  it('is total: identical records still order deterministically by id', () => {
    const a = record({ id: '00000000-0000-4000-8000-00000000000a' });
    const b = record({ id: '00000000-0000-4000-8000-00000000000b' });
    expect(orderMemories([b, a]).map((entry) => entry.id)).toEqual([a.id, b.id]);
    expect(orderMemories([a, b]).map((entry) => entry.id)).toEqual([a.id, b.id]);
  });

  it('does not mutate its input', () => {
    const records = [record({ content: 'x' }), record({ content: 'y', pinned: true })];
    const snapshot = records.map((entry) => entry.content);
    orderMemories(records);
    expect(records.map((entry) => entry.content)).toEqual(snapshot);
  });
});

describe('deduplication', () => {
  it('drops a repeat of content already kept, ignoring case and whitespace', () => {
    const first = record({ content: 'Prefers concise answers' });
    const second = record({ content: '  prefers   CONCISE answers ' });
    expect(dedupeMemories([first, second])).toHaveLength(1);
  });

  it('keeps the first occurrence, so callers order before deduplicating', () => {
    const first = record({ content: 'note', importance: 5 });
    const second = record({ content: 'note', importance: 1 });
    expect(dedupeMemories([first, second])[0]?.importance).toBe(5);
  });

  it('keeps notes that differ by a word', () => {
    expect(
      dedupeMemories([record({ content: 'use tabs' }), record({ content: 'use spaces' })]),
    ).toHaveLength(2);
  });
});

describe('search', () => {
  it('matches content case-insensitively', () => {
    const hit = record({ content: 'Prefers French for documentation' });
    const miss = record({ content: 'Runs the tests before pushing' });
    const outcome = searchMemories([hit, miss], 'french', NOW, 10);
    expect(outcome.records.map((entry) => entry.id)).toEqual([hit.id]);
  });

  it('never returns an expired record', () => {
    const expired = record({ content: 'french', expiresAt: '2020-01-01T00:00:00.000Z' });
    expect(searchMemories([expired], 'french', NOW, 10).records).toHaveLength(0);
  });

  it('reports the scope total, not the match count', () => {
    const outcome = searchMemories(
      [record({ content: 'french' }), record({ content: 'other' })],
      'french',
      NOW,
      10,
    );
    expect(outcome.records).toHaveLength(1);
    expect(outcome.total).toBe(2);
  });

  it('reports truncation rather than silently capping', () => {
    const records = Array.from({ length: 5 }, () => record({ content: 'french note' }));
    const outcome = searchMemories(records, 'french', NOW, 2);
    expect(outcome.records).toHaveLength(2);
    expect(outcome.truncated).toBe(true);
  });

  it('does not treat the query as a regular expression', () => {
    const literal = record({ content: 'uses a.b as a separator' });
    const other = record({ content: 'uses axb as a separator' });
    const outcome = searchMemories([literal, other], 'a.b', NOW, 10);
    expect(outcome.records.map((entry) => entry.id)).toEqual([literal.id]);
  });
});

describe('retrieval', () => {
  it('returns only records matching a keyword from the objective', () => {
    const relevant = record({ content: 'the permission engine must stay pure' });
    const unrelated = record({ content: 'prefers dark chocolate' });
    const outcome = retrieveMemories(
      [relevant, unrelated],
      'review the permission engine',
      NOW,
      MEMORY_MAX_RETRIEVED,
    );
    expect(outcome.records.map((entry) => entry.id)).toEqual([relevant.id]);
  });

  it('always includes a pinned record, even with no keyword match', () => {
    const pinned = record({ content: 'prefers concise answers', pinned: true });
    const outcome = retrieveMemories([pinned], 'refactor the parser', NOW, MEMORY_MAX_RETRIEVED);
    expect(outcome.records.map((entry) => entry.id)).toEqual([pinned.id]);
  });

  it('ranks more relevant records above pinned ones', () => {
    const pinned = record({ content: 'unrelated but pinned', pinned: true });
    const relevant = record({ content: 'the parser handles nested blocks' });
    const outcome = retrieveMemories([pinned, relevant], 'fix the parser', NOW, 10);
    expect(outcome.records[0]?.id).toBe(relevant.id);
  });

  it('breaks ties on importance, then confidence', () => {
    const low = record({ content: 'parser note one', importance: 1 });
    const high = record({ content: 'parser note two', importance: 5 });
    const outcome = retrieveMemories([low, high], 'parser', NOW, 10);
    expect(outcome.records[0]?.id).toBe(high.id);

    const lessSure = record({ content: 'parser note three', importance: 3, confidence: 10 });
    const moreSure = record({ content: 'parser note four', importance: 3, confidence: 95 });
    const second = retrieveMemories([lessSure, moreSure], 'parser', NOW, 10);
    expect(second.records[0]?.id).toBe(moreSure.id);
  });

  it('never returns more than the limit it is given', () => {
    const records = Array.from({ length: 30 }, (_value, index) =>
      record({ content: `parser note ${String(index)}` }),
    );
    const outcome = retrieveMemories(records, 'parser', NOW, MEMORY_MAX_RETRIEVED);
    expect(outcome.records.length).toBeLessThanOrEqual(MEMORY_MAX_RETRIEVED);
  });

  it('deduplicates identical notes drawn from different scopes', () => {
    const personal = record({ scope: 'personal', content: 'parser uses a hand-written lexer' });
    const project = record({ scope: 'project', content: 'Parser uses a hand-written lexer' });
    const outcome = retrieveMemories([personal, project], 'parser', NOW, 10);
    expect(outcome.records).toHaveLength(1);
  });

  it('never returns an expired record but still counts only the live ones', () => {
    const live = record({ content: 'parser is fine' });
    const expired = record({ content: 'parser is broken', expiresAt: '2020-01-01T00:00:00.000Z' });
    const outcome = retrieveMemories([live, expired], 'parser', NOW, 10);
    expect(outcome.records.map((entry) => entry.id)).toEqual([live.id]);
    expect(outcome.considered).toBe(1);
  });

  it('returns nothing when the objective yields no usable keyword and nothing is pinned', () => {
    const outcome = retrieveMemories([record({ content: 'anything' })], 'do it', NOW, 10);
    expect(outcome.records).toHaveLength(0);
  });
});
