/**
 * Memory record schemas (Phase 2, Milestone 8).
 *
 * A memory record is a short note the user wrote about how they want to be
 * worked with. This file is where the milestone's privacy rules are made
 * structural rather than aspirational:
 *
 *  - **A record cannot carry authority.** There is no field for a permission,
 *    a tool, an action type, a provider, a command or a path. Nothing
 *    anywhere in this codebase reads one out of `content` either — the string
 *    is stored, displayed and matched against a search query, and that is the
 *    entire set of things done with it.
 *  - **A record cannot be created by a model.** `source` is
 *    {@link MEMORY_SOURCES}, whose two members are `user` and `import`. There
 *    is no value a chat reply or an agent step could be stored under, so
 *    "never silently save model output as memory" is enforced by the absence
 *    of an enum member rather than by a check someone has to remember.
 *  - **A record cannot carry a credential by *name*.** Every object here is a
 *    `strictObject` and no field capable of holding one is declared, so a
 *    document containing `apiKey`, `token` or `password` is rejected outright
 *    rather than stored and quietly ignored. Credential-shaped *values* are a
 *    separate, weaker control applied at the write boundary — see
 *    `shared/memory/secret-scan.ts`, which is deliberately not wired in here.
 *  - **A record cannot be unbounded.** Content length, record count per
 *    scope, importance and confidence are each capped by a named constant,
 *    and the two numeric fields are ranges, so a record chooses a value
 *    *inside* the bound rather than supplying one.
 *  - **A store cannot mix scopes.** A store document declares its own scope
 *    and every record in it must agree, so a personal file claiming a
 *    project record — or a project file claiming personal ones — fails
 *    validation in full rather than being silently re-labelled.
 *
 * Pure: no I/O, no Node built-in, no Electron.
 */

import { z } from 'zod';

import {
  BIDI_CONTROL_PATTERN,
  CHAT_CONTROL_CHARACTER_PATTERN,
  MEMORY_CATEGORIES,
  MEMORY_CONFIDENCE_MAX,
  MEMORY_CONFIDENCE_MIN,
  MEMORY_CONTENT_MAX_LENGTH,
  MEMORY_CONTENT_MIN_LENGTH,
  MEMORY_IMPORTANCE_MAX,
  MEMORY_IMPORTANCE_MIN,
  MEMORY_MAX_IMPORT_RECORDS,
  MEMORY_MAX_RECORDS_PER_SCOPE,
  MEMORY_MAX_RETRIEVED,
  MEMORY_MAX_SEARCH_RESULTS,
  MEMORY_SCHEMA_VERSION,
  MEMORY_SCOPES,
  MEMORY_SEARCH_QUERY_MAX_LENGTH,
  MEMORY_SEARCH_QUERY_MIN_LENGTH,
  MEMORY_SOURCES,
} from '../constants';

export const memoryScopeSchema = z.enum(MEMORY_SCOPES);

/**
 * The scope type as the schema layer expresses it.
 *
 * Structurally identical to `MemoryScope` in `constants.ts`; re-derived here
 * so that the preload bridge and the renderer, which import only from
 * `shared/schemas`, need no second import path for one union.
 */
export type MemoryScopeValue = z.infer<typeof memoryScopeSchema>;
export const memoryCategorySchema = z.enum(MEMORY_CATEGORIES);
export const memorySourceSchema = z.enum(MEMORY_SOURCES);

/**
 * The note itself.
 *
 * Multi-line, so newlines and tabs are permitted where a display string would
 * reject them — {@link CHAT_CONTROL_CHARACTER_PATTERN} is the same relaxation
 * `chat.schema.ts` and the agent profile's `instructions` already apply — but
 * every other control character and every bidirectional override is still
 * refused, because this text is displayed and a note that renders as
 * something other than what it contains is a spoofing surface.
 *
 * Trimmed, then required to be non-empty: whitespace alone is not a note, and
 * accepting it would put an empty row in the list with nothing to show.
 */
export const memoryContentSchema = z
  .string()
  .trim()
  .min(MEMORY_CONTENT_MIN_LENGTH)
  .max(MEMORY_CONTENT_MAX_LENGTH)
  .refine((value) => !CHAT_CONTROL_CHARACTER_PATTERN.test(value), {
    message: 'must not contain control characters other than tab and newline',
  })
  .refine((value) => !BIDI_CONTROL_PATTERN.test(value), {
    message: 'must not contain bidirectional control characters',
  });

/**
 * What a caller may submit when adding or editing a record.
 *
 * Deliberately narrower than {@link memoryRecordSchema}: no `id` and no
 * `createdAt`/`updatedAt` (the main process supplies both, exactly as it does
 * for settings and agent profiles), and — the one that matters for this
 * milestone — **no `source`**. A caller cannot label its own record as having
 * come from somewhere it did not: `user` is stamped by the add handler and
 * `import` by the import handler, and those are the only two places either
 * value is written.
 */
export const memoryRecordInputSchema = z.strictObject({
  scope: memoryScopeSchema,
  category: memoryCategorySchema,
  content: memoryContentSchema,
  importance: z.int().min(MEMORY_IMPORTANCE_MIN).max(MEMORY_IMPORTANCE_MAX),
  confidence: z.int().min(MEMORY_CONFIDENCE_MIN).max(MEMORY_CONFIDENCE_MAX),
  /**
   * When this record should stop being used, or `null` for "no expiry".
   *
   * An expired record is filtered out of every list, search and retrieval,
   * and is dropped from the file on the next write to that scope. Reads never
   * write, so an expiry does not by itself cause disk activity.
   */
  expiresAt: z.iso.datetime().nullable(),
  pinned: z.boolean(),
});

export type MemoryRecordInput = z.infer<typeof memoryRecordInputSchema>;

/** A record as it is stored and as it is shown. */
export const memoryRecordSchema = memoryRecordInputSchema.extend({
  id: z.uuid(),
  source: memorySourceSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type MemoryRecord = z.infer<typeof memoryRecordSchema>;

/**
 * Shared cross-record rules for any document holding a list of records.
 *
 * Both halves close a way for a document to be internally incoherent in a
 * direction a reader would not notice: two records under one id means one of
 * them is unreachable by every operation that addresses a record by id, and a
 * record whose scope disagrees with the document's is a record in the wrong
 * file — which for a project store would be a record from *another project*.
 */
function refineRecordList(
  document: {
    readonly scope: z.infer<typeof memoryScopeSchema>;
    readonly records: readonly MemoryRecord[];
  },
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  document.records.forEach((record, index) => {
    if (seen.has(record.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['records', index, 'id'],
        message: 'duplicate record id',
      });
    }
    seen.add(record.id);

    if (record.scope !== document.scope) {
      ctx.addIssue({
        code: 'custom',
        path: ['records', index, 'scope'],
        message: 'a record must belong to the scope of the document holding it',
      });
    }
  });
}

/**
 * One scope's store, as it is held on disk (`personal` and `project`) or in
 * memory for the lifetime of one run (`session`).
 *
 * The document declares its own `scope`, which is what lets a loader say "I
 * asked for the personal store and this file says it is a project store" and
 * refuse, rather than trusting the file name it happened to open.
 */
export const memoryStoreSchema = z
  .strictObject({
    schemaVersion: z.literal(MEMORY_SCHEMA_VERSION),
    scope: memoryScopeSchema,
    records: z.array(memoryRecordSchema).max(MEMORY_MAX_RECORDS_PER_SCOPE),
  })
  .superRefine(refineRecordList);

export type MemoryStore = z.infer<typeof memoryStoreSchema>;

/** An empty store for `scope`. Used on first launch and on every load failure. */
export function createEmptyMemoryStore(scope: z.infer<typeof memoryScopeSchema>): MemoryStore {
  return { schemaVersion: MEMORY_SCHEMA_VERSION, scope, records: [] };
}

// ---------------------------------------------------------------------------
// Export and import
// ---------------------------------------------------------------------------

/**
 * The marker every export file carries.
 *
 * An import validates this literal before anything else, so a file that is
 * merely valid JSON — a package manifest, a settings file, someone's
 * unrelated data — is refused as "not a memory export" rather than being
 * probed field by field for something that happens to fit.
 */
export const MEMORY_EXPORT_KIND = 'local-agent-memory-export';

/**
 * An export document.
 *
 * Deliberately the same record shape as the store, plus a kind marker and the
 * time it was written. It carries **no path, no project name, no machine
 * name, no user name and no identifier of any kind for where it came from** —
 * an export is the notes themselves and nothing about the environment that
 * produced them, because an export is the one artefact of this application
 * designed to leave the machine.
 */
export const memoryExportSchema = z
  .strictObject({
    kind: z.literal(MEMORY_EXPORT_KIND),
    schemaVersion: z.literal(MEMORY_SCHEMA_VERSION),
    exportedAt: z.iso.datetime(),
    scope: memoryScopeSchema,
    records: z.array(memoryRecordSchema).max(MEMORY_MAX_IMPORT_RECORDS),
  })
  .superRefine(refineRecordList);

export type MemoryExport = z.infer<typeof memoryExportSchema>;

// ---------------------------------------------------------------------------
// Query results
// ---------------------------------------------------------------------------

export const memorySearchQuerySchema = z
  .string()
  .trim()
  .min(MEMORY_SEARCH_QUERY_MIN_LENGTH)
  .max(MEMORY_SEARCH_QUERY_MAX_LENGTH)
  .refine((value) => !CHAT_CONTROL_CHARACTER_PATTERN.test(value), {
    message: 'must not contain control characters',
  });

/**
 * What a list or a search answers with.
 *
 * `truncated` is reported rather than hidden, for the reason every other
 * bounded result in this codebase reports it: a caller that cannot tell a
 * complete answer from a capped one will draw a conclusion from the capped
 * one.
 */
export const memoryQueryResultSchema = z.strictObject({
  scope: memoryScopeSchema,
  records: z.array(memoryRecordSchema).max(MEMORY_MAX_SEARCH_RESULTS),
  /** How many records the scope holds in total, after expiry filtering. */
  total: z.int().min(0).max(MEMORY_MAX_RECORDS_PER_SCOPE),
  truncated: z.boolean(),
});

export type MemoryQueryResult = z.infer<typeof memoryQueryResultSchema>;

/**
 * What a retrieval answers with.
 *
 * Capped far lower than a search, at {@link MEMORY_MAX_RETRIEVED}, and that
 * cap is the point: this is the shape a model would eventually be handed, so
 * the type itself cannot express "the whole store".
 */
export const memoryRetrievalResultSchema = z.strictObject({
  records: z.array(memoryRecordSchema).max(MEMORY_MAX_RETRIEVED),
  /** How many records were considered across every readable scope. */
  considered: z.int().min(0),
});

export type MemoryRetrievalResult = z.infer<typeof memoryRetrievalResultSchema>;

/** What a clear, an export or an import reports back. */
export const memoryMutationSummarySchema = z.strictObject({
  scope: memoryScopeSchema,
  /** Records added, removed or written, depending on the operation. */
  affected: z.int().min(0).max(MEMORY_MAX_RECORDS_PER_SCOPE),
  /** Records the operation refused, for an import. Never why, per record. */
  rejected: z.int().min(0).max(MEMORY_MAX_IMPORT_RECORDS),
});

export type MemoryMutationSummary = z.infer<typeof memoryMutationSummarySchema>;
