/**
 * Memory filtering, ordering and retrieval (Phase 2, Milestone 8).
 *
 * Pure logic, deliberately: the main process, which holds the records, and
 * the renderer, which displays them, apply the identical rule rather than two
 * implementations that can drift. Nothing here reads a clock, opens a file or
 * knows what a scope is stored in — a timestamp is always passed in.
 *
 * Three properties this module is responsible for:
 *
 *  - **An expired record is never returned.** Every entry point filters by
 *    expiry first, so a record past its own `expiresAt` cannot reach a list,
 *    a search, a retrieval or an export, whatever the caller forgot to check.
 *  - **A retrieval returns a handful, never a store.** {@link retrieveMemories}
 *    is capped by its `limit` argument, which callers take from
 *    `MEMORY_MAX_RETRIEVED`. This is the shape a model would eventually be
 *    handed, and the milestone's rule is that the whole store must never be.
 *  - **Ordering is total and deterministic.** Every comparison ends in a tie
 *    break on `id`, so the same input always produces the same order — which
 *    is what makes the behaviour testable rather than incidentally stable.
 *
 * Pure: no I/O, no Node built-in, no Electron.
 */

import type { MemoryRecord } from '../schemas/memory.schema';
import { MEMORY_MAX_RETRIEVAL_KEYWORDS } from '../constants';
import { extractObjectiveKeywords } from '../workspace/plan';

/**
 * Whether `record` has passed its own expiry at `nowIso`.
 *
 * An unparseable `expiresAt` counts as **expired**, not as "no expiry": the
 * schema only permits an ISO-8601 datetime, so a value that will not parse
 * reached this function by some path that skipped validation, and treating
 * unreadable state as "keep using it indefinitely" is the wrong direction to
 * fail in for a privacy control.
 */
export function isMemoryExpired(record: MemoryRecord, nowIso: string): boolean {
  if (record.expiresAt === null) return false;

  const expiry = Date.parse(record.expiresAt);
  if (Number.isNaN(expiry)) return true;

  const now = Date.parse(nowIso);
  if (Number.isNaN(now)) return false;

  return expiry <= now;
}

/** Every record that has not expired, in the order it was given. */
export function activeMemories(records: readonly MemoryRecord[], nowIso: string): MemoryRecord[] {
  return records.filter((record) => !isMemoryExpired(record, nowIso));
}

/** Milliseconds since the epoch, or `0` for a timestamp that will not parse. */
function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * The display order: pinned first, then most recently touched.
 *
 * Pinning is the user's own "this matters" signal, so it outranks every
 * derived score — which is the whole reason the feature exists.
 */
export function orderMemories(records: readonly MemoryRecord[]): MemoryRecord[] {
  return [...records].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const byUpdated = timestamp(b.updatedAt) - timestamp(a.updatedAt);
    if (byUpdated !== 0) return byUpdated;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Collapses a record's text to the form two records are compared in.
 *
 * Case-insensitive and whitespace-insensitive, so the same note saved twice
 * with different wrapping is recognised as the same note. Nothing else is
 * normalised — two notes that differ by a word are two notes.
 */
function normalizeForComparison(content: string): string {
  return content.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Drops every record whose content repeats one already kept.
 *
 * The first occurrence in the given order wins, so callers order *before*
 * deduplicating and the survivor is the one that ranked highest rather than
 * whichever happened to be stored first.
 */
export function dedupeMemories(records: readonly MemoryRecord[]): MemoryRecord[] {
  const seen = new Set<string>();
  const kept: MemoryRecord[] = [];
  for (const record of records) {
    const key = normalizeForComparison(record.content);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(record);
  }
  return kept;
}

export interface MemorySearchOutcome {
  readonly records: readonly MemoryRecord[];
  /** How many non-expired records the scope holds, matched or not. */
  readonly total: number;
  readonly truncated: boolean;
}

/**
 * Case-insensitive substring search over record content.
 *
 * Substring matching only — never a regular expression, for the reason
 * `workspace-inspector.ts` gives for its own search: a user-supplied pattern
 * is a way to spend unbounded CPU in the process that owns every privileged
 * operation in this application.
 */
export function searchMemories(
  records: readonly MemoryRecord[],
  query: string,
  nowIso: string,
  limit: number,
): MemorySearchOutcome {
  const active = activeMemories(records, nowIso);
  const needle = query.trim().toLowerCase();
  const matched = orderMemories(
    active.filter((record) => record.content.toLowerCase().includes(needle)),
  );

  return {
    records: matched.slice(0, limit),
    total: active.length,
    truncated: matched.length > limit,
  };
}

/**
 * How strongly one record answers an objective.
 *
 * The count of distinct keywords occurring in its content. A count, not a
 * weighting — there is no scoring model here to tune or to get subtly wrong,
 * and the ordering below breaks ties on the user's own signals (pinned,
 * importance, confidence) rather than on an invented number.
 */
function relevanceOf(record: MemoryRecord, keywords: readonly string[]): number {
  const haystack = record.content.toLowerCase();
  return keywords.reduce((count, keyword) => (haystack.includes(keyword) ? count + 1 : count), 0);
}

export interface MemoryRetrievalOutcome {
  readonly records: readonly MemoryRecord[];
  /** How many non-expired records were weighed, across every scope given. */
  readonly considered: number;
}

/**
 * Selects the small set of records worth reminding someone of.
 *
 * Bounded keyword retrieval, as the milestone requires and as the coding
 * planner already does — the same {@link extractObjectiveKeywords} extractor,
 * not a second one. There is no embedding, no vector index and no background
 * indexing anywhere in this path; the whole operation is a substring scan of
 * at most `MEMORY_MAX_RECORDS_PER_SCOPE` short strings per scope.
 *
 * A **pinned** record is eligible even with no keyword match: pinning means
 * "always relevant", and a pin that only took effect when the objective
 * happened to mention the right word would not be a pin. Everything else must
 * match at least one keyword, so an unrelated note is not carried along.
 *
 * The order is: relevance, then the user's own signals, then recency, then a
 * total tie break on id. Deduplicated after ordering, so the survivor of two
 * identical notes is the higher-ranked one, and capped last.
 */
export function retrieveMemories(
  records: readonly MemoryRecord[],
  objective: string,
  nowIso: string,
  limit: number,
): MemoryRetrievalOutcome {
  const active = activeMemories(records, nowIso);
  const keywords = extractObjectiveKeywords(objective).slice(0, MEMORY_MAX_RETRIEVAL_KEYWORDS);

  const scored = active
    .map((record) => ({ record, relevance: relevanceOf(record, keywords) }))
    .filter((entry) => entry.relevance > 0 || entry.record.pinned);

  scored.sort((a, b) => {
    if (a.relevance !== b.relevance) return b.relevance - a.relevance;
    if (a.record.pinned !== b.record.pinned) return a.record.pinned ? -1 : 1;
    if (a.record.importance !== b.record.importance) {
      return b.record.importance - a.record.importance;
    }
    if (a.record.confidence !== b.record.confidence) {
      return b.record.confidence - a.record.confidence;
    }
    const byUpdated = timestamp(b.record.updatedAt) - timestamp(a.record.updatedAt);
    if (byUpdated !== 0) return byUpdated;
    return a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0;
  });

  return {
    records: dedupeMemories(scored.map((entry) => entry.record)).slice(0, limit),
    considered: active.length,
  };
}
