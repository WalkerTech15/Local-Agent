/**
 * Memory operations (Phase 2, Milestone 8).
 *
 * The layer between `main/ipc.ts`, which decides *whether* an operation may
 * happen, and `main/memory-store.ts`, which knows where the bytes are. Every
 * function here is given a {@link MemoryStoreAccess} rather than a path, so
 * this module never learns which file a scope lives in — which is what keeps
 * "project notes are isolated" a property of the accessor rather than of
 * every operation remembering to check.
 *
 * Five rules hold across everything below:
 *
 *  - **An expired record is never returned and never re-written.** Reads
 *    filter by expiry; writes persist the filtered set. Reads never write, so
 *    an expiry does not by itself cause disk activity — the record disappears
 *    from every view immediately and leaves the file at the next write to
 *    that scope.
 *  - **A record cannot change scope.** Every mutation addresses a record
 *    within one scope and refuses a record found in another. There is no
 *    "move" operation, and editing a project note into a personal one is not
 *    expressible.
 *  - **Credential-shaped content is refused at the boundary.** `add`,
 *    `update` and `import` run {@link findLikelySecret} before anything is
 *    written. The loader deliberately does not, so a rule tightened later
 *    cannot start discarding files of notes that were already stored.
 *  - **Nothing here reads a clock or generates an id.** Both are injected, as
 *    they are for every other main-process module in this codebase, so tests
 *    are deterministic and one IPC call has one timestamp throughout.
 *  - **A failure is a {@link MemoryError} and nothing else.** No filesystem
 *    error, no Zod issue and no fragment of a record's content escapes this
 *    module — the caller receives a code from a closed vocabulary.
 */

import {
  MEMORY_MAX_RECORDS_PER_SCOPE,
  MEMORY_MAX_RETRIEVED,
  MEMORY_MAX_SEARCH_RESULTS,
  MEMORY_SCHEMA_VERSION,
} from '../shared/constants';
import type { MemoryScope } from '../shared/constants';
import { MemoryError } from '../shared/memory/errors';
import { findLikelySecret } from '../shared/memory/secret-scan';
import {
  activeMemories,
  orderMemories,
  retrieveMemories,
  searchMemories,
} from '../shared/memory/retrieval';
import {
  MEMORY_EXPORT_KIND,
  memoryExportSchema,
  memoryRecordSchema,
} from '../shared/schemas/memory.schema';
import type {
  MemoryExport,
  MemoryMutationSummary,
  MemoryQueryResult,
  MemoryRecord,
  MemoryRecordInput,
  MemoryRetrievalResult,
  MemoryStore,
} from '../shared/schemas/memory.schema';

/**
 * How one scope's store is reached.
 *
 * Built in `main/ipc.ts` from the resolved user-data paths, the session store
 * and the approved-project session. A project scope with no approved project
 * throws `MEMORY_NO_PROJECT` from `read` — the refusal lives in the accessor,
 * at the one place that knows which project is open, rather than being
 * repeated in every operation.
 */
export interface MemoryStoreAccess {
  read(scope: MemoryScope): Promise<MemoryStore>;
  write(scope: MemoryScope, store: MemoryStore): Promise<void>;
}

/** The scopes a retrieval spans, in the order ties are broken. */
export type ReadableScopes = readonly MemoryScope[];

function withRecords(store: MemoryStore, records: readonly MemoryRecord[]): MemoryStore {
  return { schemaVersion: MEMORY_SCHEMA_VERSION, scope: store.scope, records: [...records] };
}

/**
 * Persists `records` to `scope`, dropping anything already expired.
 *
 * Every write goes through here, so "an expired record leaves the file at the
 * next write" is one line in one place rather than a habit each operation has
 * to keep.
 */
async function commit(
  access: MemoryStoreAccess,
  store: MemoryStore,
  records: readonly MemoryRecord[],
  now: string,
): Promise<void> {
  const pruned = activeMemories(records, now);
  try {
    await access.write(store.scope, withRecords(store, pruned));
  } catch (error) {
    // A `MemoryError` from the accessor — `MEMORY_NO_PROJECT`, say — is
    // already normalized and says something true; anything else is a
    // filesystem or validation failure whose message must not travel.
    if (error instanceof MemoryError) throw error;
    throw new MemoryError('MEMORY_STORE_FAILED');
  }
}

/** Refuses content that looks like a credential before it can be stored. */
function requireNoSecret(content: string): void {
  if (findLikelySecret(content) !== null) throw new MemoryError('MEMORY_SECRET_REJECTED');
}

function findRecord(store: MemoryStore, id: string): MemoryRecord {
  const record = store.records.find((entry) => entry.id === id);
  if (record === undefined) throw new MemoryError('MEMORY_NOT_FOUND');
  return record;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * One scope's records, most important and most recent first.
 *
 * Capped at {@link MEMORY_MAX_SEARCH_RESULTS} with `total` and `truncated`
 * reported alongside, so a caller can always tell a complete answer from a
 * capped one rather than drawing a conclusion from a silently trimmed list.
 */
export async function listMemories(
  access: MemoryStoreAccess,
  scope: MemoryScope,
  now: string,
): Promise<MemoryQueryResult> {
  const store = await access.read(scope);
  const active = orderMemories(activeMemories(store.records, now));
  return {
    scope,
    records: active.slice(0, MEMORY_MAX_SEARCH_RESULTS),
    total: active.length,
    truncated: active.length > MEMORY_MAX_SEARCH_RESULTS,
  };
}

export async function searchMemoryScope(
  access: MemoryStoreAccess,
  scope: MemoryScope,
  query: string,
  now: string,
): Promise<MemoryQueryResult> {
  const store = await access.read(scope);
  const outcome = searchMemories(store.records, query, now, MEMORY_MAX_SEARCH_RESULTS);
  return {
    scope,
    records: [...outcome.records],
    total: outcome.total,
    truncated: outcome.truncated,
  };
}

/**
 * The small, relevant set — the shape a model would eventually be handed.
 *
 * Spans every scope the session can currently read, concatenated and then
 * ranked together, so a highly relevant project note outranks an unrelated
 * personal one rather than scope order deciding it. A scope that cannot be
 * read right now (project, with nothing approved) is skipped rather than
 * failing the whole retrieval: a reminder is not worth refusing because one
 * of three sources is unavailable.
 *
 * Capped at {@link MEMORY_MAX_RETRIEVED}. The whole store is never returned
 * from here, and the response schema could not carry it if it were.
 */
export async function retrieveRelevantMemories(
  access: MemoryStoreAccess,
  scopes: ReadableScopes,
  objective: string,
  now: string,
): Promise<MemoryRetrievalResult> {
  const collected: MemoryRecord[] = [];
  for (const scope of scopes) {
    try {
      const store = await access.read(scope);
      collected.push(...store.records);
    } catch (error) {
      if (error instanceof MemoryError && error.code === 'MEMORY_NO_PROJECT') continue;
      throw error;
    }
  }

  const outcome = retrieveMemories(collected, objective, now, MEMORY_MAX_RETRIEVED);
  return { records: [...outcome.records], considered: outcome.considered };
}

// ---------------------------------------------------------------------------
// Single-record writes
// ---------------------------------------------------------------------------

/**
 * Adds one record.
 *
 * `source` is stamped `'user'` here and nowhere else in this function's
 * reach: the input schema has no such field, so a caller cannot claim its
 * note came from an import — or, more importantly, cannot claim an imported
 * record was typed by the person.
 */
export async function addMemory(
  access: MemoryStoreAccess,
  input: MemoryRecordInput,
  now: string,
  newId: () => string,
): Promise<MemoryRecord> {
  requireNoSecret(input.content);

  const store = await access.read(input.scope);
  const active = activeMemories(store.records, now);
  if (active.length >= MEMORY_MAX_RECORDS_PER_SCOPE) {
    throw new MemoryError('MEMORY_LIMIT_REACHED');
  }

  const parsed = memoryRecordSchema.safeParse({
    ...input,
    id: newId(),
    source: 'user',
    createdAt: now,
    updatedAt: now,
  });
  if (!parsed.success) throw new MemoryError('MEMORY_INVALID');

  await commit(access, store, [...active, parsed.data], now);
  return parsed.data;
}

/**
 * Replaces one record in place.
 *
 * `createdAt` and `source` are carried over from the stored record rather
 * than taken from the request, so an edit can change neither when a note was
 * written nor where it came from. The submitted scope must be the scope the
 * record already lives in — a mismatch is a refusal, not a move.
 */
export async function updateMemory(
  access: MemoryStoreAccess,
  id: string,
  input: MemoryRecordInput,
  now: string,
): Promise<MemoryRecord> {
  requireNoSecret(input.content);

  const store = await access.read(input.scope);
  const existing = findRecord(store, id);
  if (existing.scope !== input.scope) throw new MemoryError('MEMORY_SCOPE_MISMATCH');

  const parsed = memoryRecordSchema.safeParse({
    ...input,
    id,
    source: existing.source,
    createdAt: existing.createdAt,
    updatedAt: now,
  });
  if (!parsed.success) throw new MemoryError('MEMORY_INVALID');

  await commit(
    access,
    store,
    store.records.map((entry) => (entry.id === id ? parsed.data : entry)),
    now,
  );
  return parsed.data;
}

export async function setMemoryPinned(
  access: MemoryStoreAccess,
  id: string,
  scope: MemoryScope,
  pinned: boolean,
  now: string,
): Promise<MemoryRecord> {
  const store = await access.read(scope);
  const existing = findRecord(store, id);

  const updated: MemoryRecord = { ...existing, pinned, updatedAt: now };
  await commit(
    access,
    store,
    store.records.map((entry) => (entry.id === id ? updated : entry)),
    now,
  );
  return updated;
}

export async function deleteMemory(
  access: MemoryStoreAccess,
  id: string,
  scope: MemoryScope,
  now: string,
): Promise<MemoryMutationSummary> {
  const store = await access.read(scope);
  findRecord(store, id);

  await commit(
    access,
    store,
    store.records.filter((entry) => entry.id !== id),
    now,
  );
  return { scope, affected: 1, rejected: 0 };
}

// ---------------------------------------------------------------------------
// Bulk operations
// ---------------------------------------------------------------------------

/**
 * Empties one scope.
 *
 * Writes an empty document rather than deleting the file, so the result is
 * one atomic rename with the same crash safety as every other write: there is
 * no window in which the store is missing rather than empty. Note the
 * limitation this does *not* overcome — see `docs/security-model.md`: the
 * replaced file's old blocks are not securely erased, because no application
 * running on a journalling filesystem can promise that.
 */
export async function clearMemoryScope(
  access: MemoryStoreAccess,
  scope: MemoryScope,
  now: string,
): Promise<MemoryMutationSummary> {
  const store = await access.read(scope);
  const affected = activeMemories(store.records, now).length;
  await commit(access, store, [], now);
  return { scope, affected, rejected: 0 };
}

/**
 * Builds the document an export writes.
 *
 * Carries the records and the time, and **nothing about where they came
 * from**: no path, no project name, no project key, no machine name, no user
 * name. An export is the one artefact of this application designed to leave
 * the machine, so it says what the notes are and nothing about the
 * environment that produced them.
 */
export async function buildMemoryExport(
  access: MemoryStoreAccess,
  scope: MemoryScope,
  now: string,
): Promise<MemoryExport> {
  const store = await access.read(scope);
  const parsed = memoryExportSchema.safeParse({
    kind: MEMORY_EXPORT_KIND,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    exportedAt: now,
    scope,
    records: orderMemories(activeMemories(store.records, now)),
  });
  if (!parsed.success) throw new MemoryError('MEMORY_EXPORT_FAILED');
  return parsed.data;
}

/**
 * Adds validated records from an export document into `scope`.
 *
 * Two different granularities of refusal, deliberately:
 *
 *  - The **document** is all-or-nothing. If it is not a `MEMORY_EXPORT_KIND`
 *    document of this schema version, with a scope matching the target and a
 *    valid record list, nothing at all is imported. A file that is merely
 *    valid JSON is refused as "not a memory export" rather than being probed
 *    field by field for something that happens to fit.
 *  - Individual **records** may be refused while the rest import, and the
 *    count is reported. A record is refused if its content looks like a
 *    credential, or if the scope already holds the same note. Both are
 *    counted in `rejected`, which means "not imported" rather than naming a
 *    reason per record — a per-record reason would be one more way for
 *    imported content to shape what is displayed.
 *
 * Every imported record is re-stamped: a **fresh id**, so a crafted file
 * cannot collide with or address an existing record; `source: 'import'`, so
 * the interface can always show that this note came from outside; and
 * `updatedAt: now`. `createdAt` is kept from the document, because when a
 * note was originally written is the one piece of history worth carrying
 * across machines, and it is a validated ISO-8601 string either way.
 */
export async function importMemoryRecords(
  access: MemoryStoreAccess,
  scope: MemoryScope,
  document: unknown,
  now: string,
  newId: () => string,
): Promise<MemoryMutationSummary> {
  const parsedDocument = memoryExportSchema.safeParse(document);
  if (!parsedDocument.success) throw new MemoryError('MEMORY_IMPORT_INVALID');
  if (parsedDocument.data.scope !== scope) throw new MemoryError('MEMORY_IMPORT_INVALID');

  const store = await access.read(scope);
  const existing = activeMemories(store.records, now);
  const seen = new Set(existing.map((record) => normalizeContent(record.content)));

  const accepted: MemoryRecord[] = [];
  let rejected = 0;

  for (const candidate of parsedDocument.data.records) {
    if (findLikelySecret(candidate.content) !== null) {
      rejected += 1;
      continue;
    }

    const key = normalizeContent(candidate.content);
    if (seen.has(key)) {
      rejected += 1;
      continue;
    }

    const parsed = memoryRecordSchema.safeParse({
      ...candidate,
      id: newId(),
      scope,
      source: 'import',
      updatedAt: now,
    });
    if (!parsed.success) {
      rejected += 1;
      continue;
    }

    seen.add(key);
    accepted.push(parsed.data);
  }

  if (existing.length + accepted.length > MEMORY_MAX_RECORDS_PER_SCOPE) {
    // Refused outright rather than importing however many happen to fit: a
    // partial import that silently dropped the rest would look like success.
    throw new MemoryError('MEMORY_LIMIT_REACHED');
  }

  await commit(access, store, [...existing, ...accepted], now);
  return { scope, affected: accepted.length, rejected };
}

/** The same normalisation `dedupeMemories` uses, applied across documents. */
function normalizeContent(content: string): string {
  return content.toLowerCase().replace(/\s+/g, ' ').trim();
}
